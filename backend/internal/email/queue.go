package email

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Job struct {
	ID          int64
	Kind        string
	Payload     map[string]interface{}
	Attempts    int
	RunAfter    time.Time
	LockedAt    *time.Time
	CompletedAt *time.Time
	FailedAt    *time.Time
	LastError   string
	CreatedAt   time.Time
}

type EmailJob struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

type UserInviteJob struct {
	To         string `json:"to"`
	FullName   string `json:"full_name"`
	InviteLink string `json:"invite_link"`
}

type AdminInviteJob struct {
	To        string `json:"to"`
	FullName  string `json:"full_name"`
	SetupLink string `json:"setup_link"`
}

type Queue struct {
	pool    *pgxpool.Pool
	service *Service
}

func NewQueue(pool *pgxpool.Pool, service *Service) *Queue {
	return &Queue{
		pool:    pool,
		service: service,
	}
}

func (q *Queue) EnqueueUserInvite(ctx context.Context, to, fullName, inviteLink string) error {
	job := UserInviteJob{
		To:         to,
		FullName:   fullName,
		InviteLink: inviteLink,
	}

	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	_, err = q.pool.Exec(ctx, `
		INSERT INTO jobs (kind, payload)
		VALUES ('user_invite', $1)
	`, payload)

	if err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}

	return nil
}

func (q *Queue) EnqueueAdminInvite(ctx context.Context, to, fullName, setupLink string) error {
	job := AdminInviteJob{
		To:        to,
		FullName:  fullName,
		SetupLink: setupLink,
	}

	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	_, err = q.pool.Exec(ctx, `
		INSERT INTO jobs (kind, payload)
		VALUES ('admin_invite', $1)
	`, payload)

	if err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}

	return nil
}

// EnqueueRenderedEmail queues a fully rendered email (subject/body already
// templated by the API layer).
func (q *Queue) EnqueueRenderedEmail(ctx context.Context, to, subject, body string) error {
	job := EmailJob{To: to, Subject: subject, Body: body}
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}
	_, err = q.pool.Exec(ctx, `
		INSERT INTO jobs (kind, payload)
		VALUES ('send_email', $1)
	`, payload)
	if err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}
	return nil
}

func (q *Queue) EnqueueTestEmail(ctx context.Context, to string) error {
	job := EmailJob{
		To:      to,
		Subject: "WireGuard Console - Test Email",
		Body:    "Test email body",
	}

	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	_, err = q.pool.Exec(ctx, `
		INSERT INTO jobs (kind, payload)
		VALUES ('send_email', $1)
	`, payload)

	if err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}

	return nil
}

func (q *Queue) ProcessNext(ctx context.Context) error {
	var job Job
	err := q.pool.QueryRow(ctx, `
		WITH eligible AS (
			SELECT id, kind, payload, attempts, run_after
			FROM jobs
			WHERE (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
			  AND run_after <= now()
			  AND completed_at IS NULL
			  AND failed_at IS NULL
			ORDER BY created_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE jobs
		SET locked_at = now(), attempts = attempts + 1
		WHERE id = (SELECT id FROM eligible)
		RETURNING id, kind, payload, attempts, run_after, created_at
	`).Scan(
		&job.ID, &job.Kind, &job.Payload, &job.Attempts, &job.RunAfter, &job.CreatedAt,
	)

	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil
		}
		return fmt.Errorf("failed to fetch job: %w", err)
	}

	switch job.Kind {
	case "user_invite":
		var inviteJob UserInviteJob
		payloadBytes, err := json.Marshal(job.Payload)
		if err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to marshal payload: %v", err))
		}
		if err := json.Unmarshal(payloadBytes, &inviteJob); err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to unmarshal payload: %v", err))
		}
		if err := q.service.SendUserInvite(inviteJob.To, inviteJob.FullName, inviteJob.InviteLink); err != nil {
			return q.failJob(ctx, job.ID, err.Error())
		}
	case "admin_invite":
		var inviteJob AdminInviteJob
		payloadBytes, err := json.Marshal(job.Payload)
		if err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to marshal payload: %v", err))
		}
		if err := json.Unmarshal(payloadBytes, &inviteJob); err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to unmarshal payload: %v", err))
		}
		if err := q.service.SendAdminInvite(inviteJob.To, inviteJob.FullName, inviteJob.SetupLink); err != nil {
			return q.failJob(ctx, job.ID, err.Error())
		}
	case "send_email":
		var emailJob EmailJob
		payloadBytes, err := json.Marshal(job.Payload)
		if err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to marshal payload: %v", err))
		}
		if err := json.Unmarshal(payloadBytes, &emailJob); err != nil {
			return q.failJob(ctx, job.ID, fmt.Sprintf("failed to unmarshal payload: %v", err))
		}
		if err := q.service.Send(emailJob.To, emailJob.Subject, emailJob.Body); err != nil {
			return q.failJob(ctx, job.ID, err.Error())
		}
	default:
		return q.failJob(ctx, job.ID, fmt.Sprintf("unknown job kind: %s", job.Kind))
	}

	_, err = q.pool.Exec(ctx, `
		UPDATE jobs
		SET completed_at = now(), locked_at = NULL
		WHERE id = $1
	`, job.ID)

	if err != nil {
		return fmt.Errorf("failed to complete job: %w", err)
	}

	log.Printf("Processed job %d (%s)", job.ID, job.Kind)
	return nil
}

func (q *Queue) failJob(ctx context.Context, jobID int64, errMsg string) error {
	_, err := q.pool.Exec(ctx, `
		UPDATE jobs
		SET failed_at = now(), locked_at = NULL, last_error = $1
		WHERE id = $2
	`, errMsg, jobID)

	if err != nil {
		return fmt.Errorf("failed to update job: %w", err)
	}

	log.Printf("Failed job %d: %s", jobID, errMsg)
	return nil
}

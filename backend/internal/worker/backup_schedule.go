package worker

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wireguard-console/backend/internal/api"
)

// BackupScheduleWorker checks whether an automatic database backup is due.
// The due check, backup creation, S3 upload and retention all live in the API
// package so manual and scheduled backups share the same serialised path.
type BackupScheduleWorker struct {
	pool     *pgxpool.Pool
	interval time.Duration
}

func NewBackupScheduleWorker(pool *pgxpool.Pool, interval time.Duration) *BackupScheduleWorker {
	return &BackupScheduleWorker{pool: pool, interval: interval}
}

func (w *BackupScheduleWorker) Start(ctx context.Context) {
	if w.interval <= 0 {
		w.interval = time.Minute
	}
	log.Printf("Backup schedule worker started (checks every %s)", w.interval)
	w.run(ctx)

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.run(ctx)
		}
	}
}

func (w *BackupScheduleWorker) run(ctx context.Context) {
	store := api.NewStore(w.pool)
	if err := api.RunScheduledBackup(ctx, store); err != nil {
		log.Printf("Backup schedule worker: %v", err)
	}
}

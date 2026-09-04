package worker

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type RollupWorker struct {
	pool *pgxpool.Pool
}

func NewRollupWorker(pool *pgxpool.Pool) *RollupWorker {
	return &RollupWorker{pool: pool}
}

func (w *RollupWorker) Start(ctx context.Context) {
	// Run nightly at midnight
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	// Run immediately on start
	if err := w.rollup(ctx); err != nil {
		log.Printf("Failed to run initial rollup: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.rollup(ctx); err != nil {
				log.Printf("Failed to run rollup: %v", err)
			}
		}
	}
}

func (w *RollupWorker) rollup(ctx context.Context) error {
	// Roll up data older than 30 days into daily aggregates
	_, err := w.pool.Exec(ctx, `
		INSERT INTO peer_traffic_daily (peer_id, date, rx_bytes, tx_bytes)
		SELECT 
			peer_id,
			date_trunc('day', sampled_at)::date as date,
			SUM(rx_bytes),
			SUM(tx_bytes)
		FROM peer_traffic_samples
		WHERE sampled_at < now() - interval '30 days'
		GROUP BY peer_id, date_trunc('day', sampled_at)::date
		ON CONFLICT (peer_id, date) DO UPDATE SET
			rx_bytes = EXCLUDED.rx_bytes,
			tx_bytes = EXCLUDED.tx_bytes
	`)

	if err != nil {
		return fmt.Errorf("failed to roll up traffic data: %w", err)
	}

	// Delete raw samples older than 30 days
	_, err = w.pool.Exec(ctx, `
		DELETE FROM peer_traffic_samples
		WHERE sampled_at < now() - interval '30 days'
	`)

	if err != nil {
		return fmt.Errorf("failed to delete old traffic samples: %w", err)
	}

	log.Println("Traffic rollup completed")
	return nil
}

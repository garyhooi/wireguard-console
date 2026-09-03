package worker

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type TrafficWorker struct {
	pool       *pgxpool.Pool
	interval   time.Duration
	lastValues map[string]*TrafficValues
}

type TrafficValues struct {
	RXBytes uint64
	TXBytes uint64
}

func NewTrafficWorker(pool *pgxpool.Pool, interval time.Duration) *TrafficWorker {
	return &TrafficWorker{
		pool:       pool,
		interval:   interval,
		lastValues: make(map[string]*TrafficValues),
	}
}

func (w *TrafficWorker) Start(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.pollTraffic(ctx); err != nil {
				log.Printf("Failed to poll traffic: %v", err)
			}
		}
	}
}

func (w *TrafficWorker) pollTraffic(ctx context.Context) error {
	// TODO: Call wg-helper to get current peer stats
	// For now, simulate with random data
	peers := []struct {
		ID      string
		RXBytes uint64
		TXBytes uint64
	}{
		{"peer1", 1024, 2048},
		{"peer2", 512, 1024},
		{"peer3", 2048, 4096},
	}

	for _, peer := range peers {
		current := &TrafficValues{
			RXBytes: peer.RXBytes,
			TXBytes: peer.TXBytes,
		}

		last, exists := w.lastValues[peer.ID]
		if !exists {
			w.lastValues[peer.ID] = current
			continue
		}

		// Calculate delta (handle counter reset)
		var rxDelta, txDelta int64
		if current.RXBytes >= last.RXBytes {
			rxDelta = int64(current.RXBytes - last.RXBytes)
		}
		if current.TXBytes >= last.TXBytes {
			txDelta = int64(current.TXBytes - last.TXBytes)
		}

		// Store sample
		_, err := w.pool.Exec(ctx, `
			INSERT INTO peer_traffic_samples (peer_id, rx_bytes, tx_bytes)
			VALUES ($1, $2, $3)
		`, peer.ID, rxDelta, txDelta)

		if err != nil {
			log.Printf("Failed to store traffic sample for peer %s: %v", peer.ID, err)
			continue
		}

		w.lastValues[peer.ID] = current
	}

	return nil
}

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

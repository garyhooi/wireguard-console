package db

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Conn struct {
	pool *pgxpool.Pool
}

func New(databaseURL string) (*Conn, error) {
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return nil, fmt.Errorf("unable to create connection pool: %w", err)
	}

	if err := pool.Ping(context.Background()); err != nil {
		return nil, fmt.Errorf("unable to ping database: %w", err)
	}

	return &Conn{pool: pool}, nil
}

func (c *Conn) Pool() *pgxpool.Pool {
	return c.pool
}

func (c *Conn) Close() {
	c.pool.Close()
}

func RunMigrations(conn *Conn) error {
	return RunMigrationsFor(conn.pool)
}

// RunMigrationsFor applies every migration file to the given pool. Every
// migration is written to be idempotent (the runner has no tracking table and
// re-executes all files on every boot), so this is safe to call again on a live
// database — which is what backup restore does: a restored dump may predate the
// running binary's schema, and re-running migrations upgrades it in place.
func RunMigrationsFor(pool *pgxpool.Pool) error {
	migrationsDir := os.Getenv("MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = "./migrations"
	}

	files, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	for _, file := range files {
		if file.IsDir() || len(file.Name()) < 4 || file.Name()[len(file.Name())-4:] != ".sql" {
			continue
		}

		sql, err := os.ReadFile(fmt.Sprintf("%s/%s", migrationsDir, file.Name()))
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", file.Name(), err)
		}

		if _, err := pool.Exec(context.Background(), string(sql)); err != nil {
			return fmt.Errorf("failed to execute migration %s: %w", file.Name(), err)
		}

		fmt.Printf("Applied migration: %s\n", file.Name())
	}

	return nil
}

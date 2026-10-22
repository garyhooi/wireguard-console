package api

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Peer selection for user-scoped blocking rules.
//
// A user-scoped domain/IP blocking rule may carry an optional peer_ids list:
// empty means "every active peer of the user" (legacy behaviour), non-empty
// narrows enforcement to exactly those peers. The list is always stored sorted
// and de-duplicated so array equality in the unique indexes and in the
// duplicate-check queries is deterministic.

// parseRulePeerIDs decodes the optional peer_ids field of a create request. It
// rejects malformed UUIDs with a user-facing message and returns a
// de-duplicated, sorted slice (never nil).
func parseRulePeerIDs(raw []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(raw))
	seen := make(map[uuid.UUID]bool, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			return nil, fmt.Errorf("invalid peer_id %q", s)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	return ids, nil
}

// parseStoredPeerIDs decodes the comma-joined form the load/list queries select
// (array_to_string, so scanning never depends on pgx uuid[] support). Entries
// that are not valid UUIDs are dropped rather than failing the whole sync.
func parseStoredPeerIDs(raw string) []uuid.UUID {
	ids := []uuid.UUID{}
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if id, err := uuid.Parse(s); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// peerIDStrings converts peer ids back to the []string form used for
// $N::text[]::uuid[] parameters (pgx encodes []string as text[]).
func peerIDStrings(ids []uuid.UUID) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.String())
	}
	return out
}

// peerIDSet builds a lookup set for enforcement filtering.
func peerIDSet(ids []uuid.UUID) map[uuid.UUID]bool {
	if len(ids) == 0 {
		return nil
	}
	set := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// peersOwnedByUser reports whether every given peer belongs to the user.
// Soft-removed peers still belong to their user (their ids simply stop
// expanding at enforcement time), so ownership is checked on user_id only.
func peersOwnedByUser(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, peerIDs []uuid.UUID) (bool, error) {
	if len(peerIDs) == 0 {
		return true, nil
	}
	var n int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM peers
		WHERE user_id = $1 AND id = ANY($2::text[]::uuid[])
	`, userID, peerIDStrings(peerIDs)).Scan(&n)
	if err != nil {
		return false, err
	}
	return n == len(peerIDs), nil
}

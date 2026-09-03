package adguard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

type Rule struct {
	Expression string `json:"expression"`
	Enabled    bool   `json:"enabled"`
	Count      int    `json:"count,omitempty"`
}

type Filter struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	LastUpdated string `json:"last_updated"`
	RulesCount  int    `json:"rules_count"`
	Rules       []Rule `json:"rules"`
	Disabled    bool   `json:"disabled"`
	Props       Props  `json:"props"`
}

type Props struct {
	Updated        int    `json:"updated"`
	Items          int    `json:"items"`
	Filtered       int    `json:"filtered"`
	Disabled       bool   `json:"disabled"`
	Language       string `json:"language"`
	LanguageCode   string `json:"language_code"`
	LanguageCode2  string `json:"language_code_2"`
	LanguageCode3  string `json:"language_code_3"`
	LanguageName   string `json:"language_name"`
	LanguageNative string `json:"language_native"`
}

type UpdateResponse struct {
	Status string `json:"status"`
}

func NewClient() *Client {
	baseURL := os.Getenv("ADGUARD_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:3000"
	}

	apiKey := os.Getenv("ADGUARD_API_PASSWORD")

	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		httpClient: &http.Client{},
	}
}

func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)

	return c.httpClient.Do(req)
}

func (c *Client) GetFilters(ctx context.Context) ([]Filter, error) {
	resp, err := c.doRequest(ctx, "GET", "/control/list_filters", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to get filters: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("adguard returned %d: %s", resp.StatusCode, string(body))
	}

	var filters []Filter
	if err := json.NewDecoder(resp.Body).Decode(&filters); err != nil {
		return nil, fmt.Errorf("failed to decode filters: %w", err)
	}

	return filters, nil
}

func (c *Client) UpdateFilters(ctx context.Context) error {
	resp, err := c.doRequest(ctx, "POST", "/control/update_filters", nil)
	if err != nil {
		return fmt.Errorf("failed to update filters: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *Client) SetCustomRules(ctx context.Context, rules []string) error {
	body := map[string]interface{}{
		"rules": rules,
	}

	resp, err := c.doRequest(ctx, "POST", "/control/set_custom_rules", body)
	if err != nil {
		return fmt.Errorf("failed to set custom rules: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("adguard returned %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *Client) GetStats(ctx context.Context) (map[string]interface{}, error) {
	resp, err := c.doRequest(ctx, "GET", "/control/stats", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to get stats: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("adguard returned %d: %s", resp.StatusCode, string(body))
	}

	var stats map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return nil, fmt.Errorf("failed to decode stats: %w", err)
	}

	return stats, nil
}

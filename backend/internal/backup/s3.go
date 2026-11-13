package backup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Config is a generic S3-compatible destination. Endpoint may be empty for
// AWS S3; otherwise it must include http:// or https://. Path-style addressing
// is available for MinIO and other providers that require it.
type S3Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	ForcePathStyle  bool
}

func (c S3Config) normalizedPrefix() string {
	return strings.Trim(strings.TrimSpace(c.Prefix), "/")
}

// Key returns the object key for a local backup filename.
func (c S3Config) Key(filename string) string {
	name := filepath.Base(strings.TrimSpace(filename))
	prefix := c.normalizedPrefix()
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}

func (c S3Config) Validate() error {
	if strings.TrimSpace(c.Bucket) == "" {
		return fmt.Errorf("S3 bucket is required")
	}
	if strings.ContainsAny(c.Bucket, "/\\ \t\r\n") {
		return fmt.Errorf("S3 bucket name contains invalid whitespace or path characters")
	}
	if c.Region == "" {
		return fmt.Errorf("S3 region is required")
	}
	if c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("S3 endpoint must be a valid http(s) URL")
		}
		if u.User != nil {
			return fmt.Errorf("S3 endpoint must not include credentials in the URL")
		}
	}
	if (c.AccessKeyID == "") != (c.SecretAccessKey == "") {
		return fmt.Errorf("S3 access key ID and secret access key must be provided together")
	}
	if c.SessionToken != "" && c.AccessKeyID == "" {
		return fmt.Errorf("S3 session token requires an access key ID and secret access key")
	}
	for _, part := range strings.Split(c.normalizedPrefix(), "/") {
		if part == "." || part == ".." {
			return fmt.Errorf("S3 prefix cannot contain . or .. segments")
		}
	}
	return nil
}

func (c S3Config) client(ctx context.Context) (*s3.Client, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	region := strings.TrimSpace(c.Region)
	if region == "" {
		region = "us-east-1"
	}
	loadOpts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(region),
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	}
	if c.AccessKeyID != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, c.SessionToken),
		))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	awsCfg.HTTPClient = &http.Client{Timeout: 30 * time.Minute}
	return s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = c.ForcePathStyle
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
	}), nil
}

// Upload sends a local backup file to the configured bucket/key. It uses the
// S3 manager so large archives use multipart uploads.
func (c S3Config) Upload(ctx context.Context, localPath, key string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	uploader := manager.NewUploader(client)
	_, err = uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.Bucket),
		Key:         aws.String(key),
		Body:        f,
		ContentType: aws.String("application/octet-stream"),
		Metadata: map[string]string{
			"wgconsole-backup": filepath.Base(localPath),
		},
	})
	if err != nil {
		return fmt.Errorf("upload S3 object: %w", err)
	}
	return nil
}

func (c S3Config) Delete(ctx context.Context, key string) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	if _, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
	}); err != nil {
		return fmt.Errorf("delete S3 object: %w", err)
	}
	return nil
}

// Test verifies the bucket is reachable and that the credentials can list,
// put, get and delete under the configured prefix. The probe object is removed
// on success and best-effort cleanup is attempted on failure.
func (c S3Config) Test(ctx context.Context) error {
	client, err := c.client(ctx)
	if err != nil {
		return err
	}
	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(c.Bucket)}); err != nil {
		return fmt.Errorf("check S3 bucket %q: %w", c.Bucket, err)
	}
	random := make([]byte, 6)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	key := c.Key(".wgc-permission-test-" + hex.EncodeToString(random))
	body := []byte("wireguard-console S3 permission probe")
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.Bucket),
		Key:         aws.String(key),
		Body:        strings.NewReader(string(body)),
		ContentType: aws.String("text/plain"),
	}); err != nil {
		return fmt.Errorf("put S3 object: %w", err)
	}
	defer func() {
		_, _ = client.DeleteObject(context.Background(), &s3.DeleteObjectInput{
			Bucket: aws.String(c.Bucket),
			Key:    aws.String(key),
		})
	}()
	out, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("get S3 object: %w", err)
	}
	defer out.Body.Close()
	got, err := io.ReadAll(out.Body)
	if err != nil {
		return fmt.Errorf("read S3 object: %w", err)
	}
	if string(got) != string(body) {
		return fmt.Errorf("S3 permission probe returned unexpected content")
	}
	if _, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
	}); err != nil {
		return fmt.Errorf("delete S3 object: %w", err)
	}
	return nil
}

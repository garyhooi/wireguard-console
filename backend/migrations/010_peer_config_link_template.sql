-- Peer config emails now deliver a secure access link instead of embedding
-- the raw config (which contains the private key). Existing installs that
-- still have the old {{config}}-embedding peer_config template are reworded
-- to the {{config_link}} version. Only rows that still reference {{config}}
-- are touched — an admin who already customized the template keeps their
-- wording (the {{config}} placeholder no longer receives a value, so they
-- should switch to {{config_link}} manually).
UPDATE email_templates
SET body = '<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;"><h2>Hello {{full_name}},</h2><p>Your WireGuard peer <strong>{{peer_name}}</strong> is ready. Open the link below to download the config file or scan its QR code with the WireGuard app:</p><p><a href="{{config_link}}" style="display: inline-block; padding: 12px 24px; background-color: #0d9488; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Get Your Config</a></p><p style="margin-top: 24px; color: #666; font-size: 14px;">This link is private — do not forward it. It expires automatically.</p></body></html>',
    updated_at = now()
WHERE key = 'peer_config'
  AND body LIKE '%{{config}}%';

-- Editable email templates. Placeholders use {{variable}} syntax:
--   user_invite: {{full_name}}, {{invite_link}}
--   peer_config: {{full_name}}, {{peer_name}}, {{config_link}}
CREATE TABLE IF NOT EXISTS email_templates (
    key     TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body    TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO email_templates (key, subject, body) VALUES
('user_invite', 'You''ve been invited to join WireGuard Console',
 '<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;"><h2>Welcome to WireGuard Console</h2><p>Hello {{full_name}},</p><p>An administrator has invited you to claim your VPN account. Click the button below to set it up:</p><p><a href="{{invite_link}}" style="display: inline-block; padding: 12px 24px; background-color: #0d9488; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Claim Account</a></p><p style="margin-top: 24px; color: #666; font-size: 14px;">If you didn''''t expect this invitation, you can safely ignore this email.</p></body></html>'),
('admin_invite', 'You''ve been invited to manage WireGuard Console',
 '<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;"><h2>Welcome to WireGuard Console</h2><p>You have been invited as a console administrator.</p><p>Login at <a href="{{console_url}}">{{console_url}}</a> with email <strong>{{email}}</strong> and the temporary password <strong>{{password}}</strong>.</p><p style="margin-top: 24px; color: #666; font-size: 14px;">Change your password after your first login (Profile &rarr; Change password), and enroll 2FA.</p></body></html>'),
('peer_config', 'Your WireGuard configuration is ready',
 '<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;"><h2>Hello {{full_name}},</h2><p>Your WireGuard peer <strong>{{peer_name}}</strong> is ready. Open the link below to download the config file or scan its QR code with the WireGuard app:</p><p><a href="{{config_link}}" style="display: inline-block; padding: 12px 24px; background-color: #0d9488; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Get Your Config</a></p><p style="margin-top: 24px; color: #666; font-size: 14px;">This link is private — do not forward it. It expires automatically.</p></body></html>')
ON CONFLICT (key) DO NOTHING;
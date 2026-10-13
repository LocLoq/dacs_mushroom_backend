-- Cancel outstanding deliveries of retired providers without deleting history.
UPDATE push_deliveries d JOIN push_devices p ON p.id=d.device_id
SET d.cancelled_at=NOW(3)
WHERE p.provider IN ('unifiedpush','apns') AND d.sent_at IS NULL AND d.cancelled_at IS NULL;
UPDATE push_devices SET active=false WHERE provider IN ('unifiedpush','apns') AND active=true;

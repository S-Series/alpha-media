CREATE INDEX mock_pg_payment_ledger_idx ON mock_pg_payments(created_at,payment_id);
CREATE INDEX mock_pg_cancellation_ledger_idx ON mock_pg_cancellations(created_at,id);
CREATE INDEX mock_pg_cancellation_payment_idx ON mock_pg_cancellations(payment_id,created_at,id);

-- Existing terminal rows have no recorded completion timestamp; include them in the first daily scan.
ALTER TABLE mock_supplier_orders ADD COLUMN ledger_updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
UPDATE mock_supplier_orders SET ledger_updated_at=created_at WHERE status='ACCEPTED';
CREATE FUNCTION touch_supplier_ledger() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
    IF (NEW.status,NEW.supplier_order_no,NEW.accepted_event_id,NEW.result_event_id,NEW.iccid,NEW.activation_code)
        IS DISTINCT FROM (OLD.status,OLD.supplier_order_no,OLD.accepted_event_id,OLD.result_event_id,OLD.iccid,OLD.activation_code) THEN
        NEW.ledger_updated_at=clock_timestamp();
    ELSE
        NEW.ledger_updated_at=OLD.ledger_updated_at;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION touch_supplier_ledger() FROM PUBLIC;
CREATE TRIGGER mock_supplier_ledger_update BEFORE UPDATE ON mock_supplier_orders
    FOR EACH ROW EXECUTE FUNCTION touch_supplier_ledger();
CREATE INDEX mock_supplier_ledger_idx ON mock_supplier_orders(ledger_updated_at,request_id);
CREATE INDEX mock_supplier_order_ledger_idx ON mock_supplier_orders(order_id,ledger_updated_at,request_id);

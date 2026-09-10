-- Marca explícita de "revisado" sobre un push analizado, hecha por un humano —
-- reemplaza el uso de notified_at/promotions como proxy de "atendido".
ALTER TABLE review_runs
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users (id);

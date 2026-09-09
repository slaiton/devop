-- Vincula la identidad de login (users, viene de GitHub OAuth) con la identidad de
-- contribución (developers, viene de los webhooks de push/PR) para que un usuario con
-- rol "developer" pueda ver sus propios review_runs sin exponer los de otros.
ALTER TABLE developers ADD COLUMN user_id uuid REFERENCES users (id);

CREATE INDEX developers_user_idx ON developers (user_id);

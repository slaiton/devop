-- El login deja de dar de alta usuarios a ciegas: a partir de ahora un admin
-- pre-registra a alguien por correo (fila `users` con github_user_id NULL) y esa fila
-- se "reclama" (se le setea github_user_id) la primera vez que esa persona se loguea
-- con GitHub y su correo coincide. `github_user_id` deja de ser obligatorio para
-- soportar ese estado "pendiente"; el índice único por correo (case-insensitive) es la
-- clave de matching y evita duplicados.
ALTER TABLE users ALTER COLUMN github_user_id DROP NOT NULL;

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

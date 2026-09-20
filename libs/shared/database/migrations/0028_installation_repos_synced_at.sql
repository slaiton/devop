-- Antes, los repos de una instalación solo se poblaban vía los webhooks
-- `installation`/`installation_repositories` — si el webhook de una GitHub App nunca
-- llegó a configurarse bien (URL/secret incorrectos), la instalación quedaba
-- "conectada" en la UI pero sin ningún repo, sin ninguna señal visible del problema.
-- Esta columna registra la última vez que se sincronizaron repos para una instalación
-- (por webhook o por el botón manual "sincronizar ahora") — NULL significa "nunca", la
-- señal que la UI de /accounts usa para avisar que algo no llegó a sincronizar.
ALTER TABLE github_installations ADD COLUMN repos_synced_at timestamptz;

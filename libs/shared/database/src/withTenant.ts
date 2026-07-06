import type { PoolClient } from 'pg';
import { getPool } from './pool';

/**
 * Toda lectura/escritura de datos de un tenant debe pasar por aquí.
 * set_config (no SET LOCAL con interpolación) para que organizationId
 * viaje como parámetro y nunca como texto concatenado en el SQL.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

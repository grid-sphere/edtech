import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

/*
 * No fallback connection string.
 *
 * This used to default to a full production URL — host, database, username and
 * password — sitting in the source. Anyone who cloned the repo had working
 * credentials to the live database, and every push republished them.
 *
 * A default is worse than useless here even ignoring the leak: a misconfigured
 * staging box would silently connect to production and start writing to it.
 * Refusing to start is the only safe behaviour, and the error says exactly what
 * to do about it.
 */
if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set.\n" +
        "  Create backend/edtech/.env with:\n" +
        "    DATABASE_URL=postgresql://user:password@host:5432/dbname\n" +
        "  See .env.example for the full list of variables."
    );
}

/*
 * SSL follows the connection string instead of being hardcoded.
 *
 * It used to be a flat `ssl: false`, because the self-hosted Postgres rejected
 * SSL outright. That is fine for a database on a private network and wrong for
 * a managed one — Neon, Supabase, RDS and friends all require TLS, and an
 * explicit `ssl: false` overrides whatever `sslmode` the URL asks for, so the
 * connection fails with a message about the server not supporting SSL that
 * sounds like the opposite of the real problem.
 *
 * Reading it from the URL means moving between the two is a .env change and
 * nothing else.
 *
 * rejectUnauthorized stays true: Neon and the other managed providers present
 * certificates from public CAs that Node already trusts, so verification costs
 * nothing. Turning it off — which half the tutorials tell you to do — accepts
 * any certificate at all and quietly removes the protection TLS was for.
 * DATABASE_SSL_INSECURE exists for a provider using a private CA, and should be
 * a last resort.
 */
const url = process.env.DATABASE_URL;
const wantsSsl =
    /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(url) ||
    process.env.DATABASE_SSL === "true";

const pool = new Pool({
    connectionString: url,
    ssl: wantsSsl
        ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== "true" }
        : false,
});

export default pool;

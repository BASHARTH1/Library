# Local database â€” portable PostgreSQL 18 + pgvector

The project runs against a **self-contained PostgreSQL cluster** stored under
`.localdb/`. It needs no administrator rights, does not touch the machine's
system PostgreSQL service, and listens on port **5433** (the system instance
keeps 5432).

```
.localdb/
  pgsql/        runtime copied from C:\Program Files\PostgreSQL\18 (bin, lib, share)
  data/         the cluster data directory
  pg.log        server log
```

## Daily use

```powershell
npm run db:start     # start the cluster
npm run db:status    # readiness + row counts
npm run db:stop      # stop it
node scripts/db.mjs psql   # open a psql shell on the app database
```

Connection string shape (the real one lives in `.env`, which is gitignored):

```
DATABASE_URL=postgresql://postgres:<DATABASE_PASSWORD>@127.0.0.1:5433/gulf_research_repository
```

`scripts/db.mjs` reads `DATABASE_PASSWORD` from `.env` â€” no credential is hardcoded
in source, including for this local-only cluster.

## Why a portable cluster

The machine's system PostgreSQL 18 is running but its `postgres` password was
unknown, and installing pgvector into `C:\Program Files` requires elevation.
Copying the runtime into a user-writable directory avoids both problems and keeps
the project reproducible without admin rights.

## How it was built

pgvector ships no Windows binaries, so it was compiled from source against this
machine's PostgreSQL 18 headers using the installed MSVC Build Tools:

```powershell
git clone --branch v0.8.1 --depth 1 https://github.com/pgvector/pgvector.git
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "PGROOT=C:\Program Files\PostgreSQL\18"
nmake /F Makefile.win
```

`vector.dll`, `vector.control` and `vector--0.8.1.sql` were then copied into
`.localdb/pgsql/lib` and `.localdb/pgsql/share/extension`.

## Recreating from scratch

```powershell
# 1. copy the runtime
robocopy "C:\Program Files\PostgreSQL\18\bin"   .localdb\pgsql\bin   /E
robocopy "C:\Program Files\PostgreSQL\18\lib"   .localdb\pgsql\lib   /E
robocopy "C:\Program Files\PostgreSQL\18\share" .localdb\pgsql\share /E

# 2. add pgvector (build it as above, then copy the three artefacts)

# 3. initialise and start
.localdb\pgsql\bin\initdb.exe -D .localdb\data -U postgres --pwfile=<file containing DATABASE_PASSWORD> --encoding=UTF8 --locale=C
npm run db:start

# 4. create the database, extensions and schema
$env:PGPASSWORD='<DATABASE_PASSWORD>'
.localdb\pgsql\bin\psql.exe -U postgres -h 127.0.0.1 -p 5433 -d postgres -c "CREATE DATABASE gulf_research_repository;"
.localdb\pgsql\bin\psql.exe -U postgres -h 127.0.0.1 -p 5433 -d gulf_research_repository -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION pgcrypto;"
.localdb\pgsql\bin\psql.exe -U postgres -h 127.0.0.1 -p 5433 -d gulf_research_repository -f docs\schema\001_initial_schema.sql
```

## Moving to Supabase or another server later

Nothing in the application code is tied to this cluster. Change `DATABASE_URL`
in `.env` and apply `docs/schema/001_initial_schema.sql` to the target database.

For Supabase specifically: the direct host `db.<ref>.supabase.co` has **no DNS
record** for this project, so use the **pooler** connection string from
Dashboard â†’ Connect â†’ Session pooler.


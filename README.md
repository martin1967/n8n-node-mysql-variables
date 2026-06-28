# n8n-nodes-mysql-variables

A custom community node for **n8n Community Edition** that stores variables
(cookies, API keys, client id/secret and any other values) in **MySQL** or in
**embedded SQLite** (no separate database server — chosen in the credential).

Compared to existing solutions:

| Solution | Persist | Read/Write | Isolation | Encryption |
|---|---|---|---|---|
| `$vars` (native) | ✅ | ✅ | — | — (Enterprise only) |
| `n8n-nodes-globals` | ✅ | read only | ❌ | ❌ |
| `n8n-nodes-datastore` | ❌ (RAM) | ✅ | ❌ | ❌ |
| **this package** | ✅ SQLite/MySQL | ✅ | ✅ (per credential) | ✅ AES-256-GCM |

## Storage: SQLite or MySQL

The **Storage** field in the credential switches the backend:

- **SQLite (embedded)** — the default. No database server, nothing to set up.
  Data lives in a file inside the n8n data folder; the file path is resolved
  **automatically** from the `Username`/Encryption Key (see "Isolation & sharing").
  Built on `sql.js` (WASM) — it compiles inside the n8n Docker image with no
  native build step. Great when colleagues don't have their own MySQL.
  Limitation: the store is local to that n8n instance (not shared over the
  network across multiple servers).
- **MySQL** — a central store, shared across multiple n8n instances, with the
  option to give each person their own MySQL login.

The logic (flat key→value, AES encryption, operations) is identical for both backends.

> Keep the SQLite file on a mounted volume (`~/.n8n`), otherwise data won't
> survive container recreation.

## Features

- **Operations:** Get, Get All Keys, Set (upsert), Create, Update, Delete, Clear (empty a value).
- **Flat key→value:** one store = one SQLite file (or one MySQL table). Keys are unique within a store.
- **Encryption at rest:** values are AES-256-GCM encrypted before they are written; the database holds ciphertext.
- **Value types:** String and JSON.
- **Usable as Tool:** the node can be attached to n8n AI agents.

## Isolation & sharing (SQLite)

**The Encryption Key is the store's access secret**, not just an encryption key.
The file path is derived from a hash of the `Encryption Key` (+ an optional
`Username`), so you **cannot** open or list someone else's store by knowing only
their `Username` — you need the exact key.

The path is resolved automatically. Priority:

1. **`Username` set** → `n8n-vars-<username>-<hash(key)>.sqlite`. `Username` is just a
   label (you can keep several stores under one key); access is governed by the key.
2. **`Username` empty** → `n8n-vars-<hash(key)>.sqlite` (one store per key).
3. **Advanced → Custom File Path** → an explicit path (for power users), overrides everything.

To share a store with a team:

- **share the credential itself** with colleagues (n8n credential sharing), **or**
- give them the same `Username` **and** `Encryption Key`.

> ⚠️ This protects access **through the UI** (guessing another user's `Username`
> is useless without the key). File storage does not protect against someone with
> disk access to `~/.n8n` — for hard multi-user isolation use n8n credential
> sharing and don't grant direct filesystem access. Values are encrypted with the
> `Encryption Key` either way.

## Table schema

Created automatically (`Auto-create Table` = on). SQL to create it manually (MySQL):

```sql
CREATE TABLE IF NOT EXISTS `n8n_variables` (
  `key`        VARCHAR(190) NOT NULL,
  `value`      LONGTEXT NULL,
  `type`       VARCHAR(20) NOT NULL DEFAULT 'string',
  `encrypted`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

With MySQL, isolation is done via a **separate table** (`Table Name`) or a separate database per credential.

## Install

### Recommended — via the Community Nodes UI

**Settings → Community nodes → Install a community node**, then enter:

```
n8n-nodes-mysql-variables
```

Requires `N8N_COMMUNITY_PACKAGES_ENABLED=true` (default on self-hosted). To use
the node as a tool for AI agents, also set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

### Build from source

```bash
npm install
npm run build      # -> dist/
```

### Manual install (Docker, self-hosted)

#### Option A — local custom folder (quick, no npm publish)

```bash
# 1. Build and pack
npm install && npm run build
npm pack            # -> n8n-nodes-mysql-variables-<version>.tgz

# 2. Install into the custom folder that is mounted into the container
mkdir -p ~/n8n-data/custom
cd ~/n8n-data/custom
npm init -y
npm install /full/path/n8n-nodes-mysql-variables-<version>.tgz   # pulls in mysql2
```

```bash
# 3. Start n8n with ~/n8n-data mounted at /home/node/.n8n
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -e N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/custom \
  -e N8N_COMMUNITY_PACKAGES_ENABLED=true \
  -v ~/n8n-data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

n8n picks up the node from `~/.n8n/custom` automatically. After a restart it
appears in the palette as **MySQL Variables**.

#### Option B — custom Docker image (for production)

```dockerfile
FROM docker.n8n.io/n8nio/n8n:latest
USER root
COPY . /opt/n8n-nodes-mysql-variables
RUN cd /opt/n8n-nodes-mysql-variables && npm install && npm run build \
 && mkdir -p /opt/custom && cd /opt/custom && npm init -y \
 && npm install /opt/n8n-nodes-mysql-variables
ENV N8N_CUSTOM_EXTENSIONS=/opt/custom
USER node
```

```bash
docker build -t n8n-with-vars .
docker run -it --rm -p 5678:5678 -v ~/n8n-data:/home/node/.n8n n8n-with-vars
```

#### docker-compose (example)

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    ports:
      - "5678:5678"
    environment:
      - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/custom
      - N8N_COMMUNITY_PACKAGES_ENABLED=true
    volumes:
      - ./n8n-data:/home/node/.n8n
```

## Credential setup

In n8n, create a **MySQL Variables API** credential:

| Field | Description |
|---|---|
| **Storage** | `SQLite (embedded)` or `MySQL`. |
| **Encryption Key** | AES key **and the store's access secret** (the file is derived from it). |
| Username | SQLite only. Store label (not a secret). Empty → one store per key. |
| Advanced: Custom File Path → SQLite File Path | SQLite only, for power users: an explicit file path. |
| Host / Port / Database / User / Password / SSL | MySQL only. In Docker `localhost` ≠ host — see below. |
| Table Name | MySQL only. Isolate by using a separate table/database per credential. |
| Auto-create Table | Create the table automatically. |

> **Docker + MySQL:** inside the n8n container `localhost` points to the container
> itself. Use the MySQL container/service name (shared docker network) or
> `host.docker.internal` for a database on the host machine. This is the cause of
> the `connect ECONNREFUSED ::1:3306` error.

## Using it in expressions

```js
// read a variable value from the MySQL Variables node
{{ $('MySQL Variables').item.json.value }}
```

Typical pattern: a **MySQL Variables (Get)** node at the start of the workflow →
the value is then used in HTTP Request / other nodes via the expression above.

## Operations

| Operation | What it does |
|---|---|
| **Get Variable** | Read a value by key |
| **Get All Keys** | List all keys (optionally with values) |
| **Set Variable** | Upsert (create or update) |
| **Create Variable** | Insert, error if it already exists |
| **Update Variable** | Update, error if missing |
| **Delete Variable** | Remove the key entirely |
| **Clear Variable** | Empty the value, keep the key |

## License

MIT

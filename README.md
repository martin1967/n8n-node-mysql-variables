# n8n-nodes-mysql-variables

**English** | [Русский](#-русский-russian)

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

---

## 🇷🇺 Русский (Russian)

[English](#n8n-nodes-mysql-variables) | **Русский**

Кастомная community-нода для **n8n Community Edition**, которая хранит переменные
(куки, API-ключи, client id/secret и любые другие значения) в **MySQL** или во
**встроенной SQLite** (без отдельного сервера БД — выбирается в credential).

В отличие от готовых решений:

| Решение | Persist | Read/Write | Изоляция | Шифрование |
|---|---|---|---|---|
| `$vars` (native) | ✅ | ✅ | — | — (Enterprise only) |
| `n8n-nodes-globals` | ✅ | только чтение | ❌ | ❌ |
| `n8n-nodes-datastore` | ❌ (RAM) | ✅ | ❌ | ❌ |
| **этот пакет** | ✅ SQLite/MySQL | ✅ | ✅ (по credential) | ✅ AES-256-GCM |

### Хранилище: SQLite или MySQL

Поле **Storage** в credential переключает бэкенд:

- **SQLite (embedded)** — по умолчанию. Никакого сервера БД, ничего настраивать не надо.
  Данные лежат в файле внутри папки данных n8n; путь к файлу подбирается **автоматически**
  по `Username`/ключу (см. «Изоляция и шеринг»). Реализовано на `sql.js` (WASM) — собирается
  в Docker-образе n8n без нативной компиляции. Подходит, когда у коллег нет своей MySQL.
  Ограничение: store локален для этого инстанса n8n (не шарится по сети между серверами).
- **MySQL** — централизованное хранилище, общее для нескольких инстансов n8n, с возможностью
  дать каждому свой MySQL-логин.

Логика (плоский key→value, AES-шифрование, операции) одинакова для обоих бэкендов.

> SQLite-файл держи на смонтированном volume (`~/.n8n`), иначе данные не переживут пересоздание контейнера.

### Возможности

- **Операции:** Get, Get All Keys, Set (upsert), Create, Update, Delete, Clear (обнулить значение).
- **Плоский key→value:** один store = один файл SQLite (или одна таблица MySQL). Ключ уникален в рамках store.
- **Шифрование at rest:** значения шифруются AES-256-GCM перед записью; в БД лежит шифротекст.
- **Типы значений:** String и JSON.
- **Usable as Tool:** ноду можно подключать к AI-агентам n8n.

### Изоляция и шеринг (SQLite)

**Encryption Key — это секрет доступа к стору**, а не только ключ шифрования. Путь к файлу
выводится из хеша `Encryption Key` (+ опционального `Username`), поэтому открыть или просмотреть
чужой стор, зная только его `Username`, **нельзя** — нужен точный ключ.

Путь подбирается автоматически. Приоритет:

1. **`Username` задан** → `n8n-vars-<username>-<хеш(ключ)>.sqlite`. `Username` — просто метка
   (можно держать несколько сторов на один ключ); доступ решает ключ.
2. **`Username` пуст** → `n8n-vars-<хеш(ключ)>.sqlite` (один стор на ключ).
3. **Advanced → Custom File Path** → явный путь (для профи), перекрывает всё.

Расшарить store на команду:

- **расшарить сам credential** коллегам (Credential sharing в n8n), **или**
- сообщить им одинаковый `Username` **и** `Encryption Key`.

> ⚠️ Это защищает доступ **через UI** (подбор чужого `Username` без ключа бесполезен).
> Файловое хранилище не защищает от того, у кого есть доступ к диску `~/.n8n` — для жёсткой
> многопользовательской изоляции используй credential sharing n8n и не давай прямой доступ к ФС.
> Значения в любом случае зашифрованы `Encryption Key`.

### Схема таблицы

Создаётся автоматически (`Auto-create Table` = on). SQL для ручного создания (MySQL):

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

При MySQL изоляция делается через **отдельную таблицу** (`Table Name`) или отдельную БД на credential.

### Установка

#### Рекомендованный способ — через UI Community Nodes

**Settings → Community nodes → Install a community node**, затем впиши:

```
n8n-nodes-mysql-variables
```

Нужен `N8N_COMMUNITY_PACKAGES_ENABLED=true` (по умолчанию включён на self-hosted). Чтобы
использовать ноду как tool в AI-агентах, добавь ещё `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

#### Сборка из исходников

```bash
npm install
npm run build      # -> dist/
```

#### Ручная установка (Docker, self-hosted)

**Вариант A — локальная папка custom (быстро, без публикации в npm):**

```bash
# 1. Собрать и упаковать
npm install && npm run build
npm pack            # -> n8n-nodes-mysql-variables-<version>.tgz

# 2. Поставить в папку custom, которая монтируется в контейнер
mkdir -p ~/n8n-data/custom
cd ~/n8n-data/custom
npm init -y
npm install /full/path/n8n-nodes-mysql-variables-<version>.tgz   # подтянет mysql2
```

```bash
# 3. Запустить n8n, смонтировав ~/n8n-data в /home/node/.n8n
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -e N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/custom \
  -e N8N_COMMUNITY_PACKAGES_ENABLED=true \
  -v ~/n8n-data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

После рестарта нода появится в палитре как **MySQL Variables**.

**Вариант B — свой Docker-образ (для прода):**

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

### Настройка credential

В n8n создай credential **MySQL Variables API**:

| Поле | Описание |
|---|---|
| **Storage** | `SQLite (embedded)` или `MySQL`. |
| **Encryption Key** | Ключ AES **и секрет доступа к стору** (из него выводится файл). |
| Username | Только SQLite. Метка стора (не секрет). Пусто → один стор на ключ. |
| Advanced: Custom File Path → SQLite File Path | Только SQLite, для профи: явный путь к файлу. |
| Host / Port / Database / User / Password / SSL | Только MySQL. В Docker `localhost` ≠ хост — см. ниже. |
| Table Name | Только MySQL. Изоляция — своя таблица/БД на credential. |
| Auto-create Table | Создавать таблицу автоматически. |

> **Docker + MySQL:** `localhost` внутри контейнера n8n указывает на сам контейнер.
> Используй имя сервиса/контейнера MySQL (общая docker-сеть) либо `host.docker.internal`
> для базы на хост-машине. Это причина ошибки `connect ECONNREFUSED ::1:3306`.

### Использование в выражениях

```js
// получить значение переменной из ноды MySQL Variables
{{ $('MySQL Variables').item.json.value }}
```

Типичный паттерн: нода **MySQL Variables (Get)** в начале workflow → дальше значение
используется в HTTP Request / прочих нодах через выражение выше.

### Операции

| Операция | Что делает |
|---|---|
| **Get Variable** | Читает значение по ключу |
| **Get All Keys** | Список всех ключей (опц. со значениями) |
| **Set Variable** | Upsert (создать или обновить) |
| **Create Variable** | Вставить, ошибка если уже есть |
| **Update Variable** | Обновить, ошибка если нет |
| **Delete Variable** | Удалить ключ целиком |
| **Clear Variable** | Обнулить значение, ключ оставить |

### Лицензия

MIT

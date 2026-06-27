# n8n-nodes-mysql-variables

Кастомная community-нода для **n8n Community Edition**, которая хранит переменные
(куки, API-ключи, client id/secret и любые другие значения) в **MySQL** или во
**встроенной SQLite** (без отдельного сервера БД — выбирается в credential).

В отличие от готовых решений:

| Решение | Persist | Read/Write | Multi-user | Шифрование |
|---|---|---|---|---|
| `$vars` (native) | ✅ | ✅ | ✅ | — (Enterprise only) |
| `n8n-nodes-globals` | ✅ | только чтение | ❌ | ❌ |
| `n8n-nodes-datastore` | ❌ (RAM) | ✅ | ❌ | ❌ |
| **этот пакет** | ✅ MySQL | ✅ | ✅ (по аккаунтам) | ✅ AES-256-GCM |

## Хранилище: SQLite или MySQL

В credential поле **Storage** переключает бэкенд:

- **SQLite (embedded)** — по умолчанию. Никакого сервера БД, ничего настраивать не надо.
  Данные лежат в файле внутри папки данных n8n (по умолчанию `<user folder>/n8n-mysql-variables.sqlite`).
  Реализовано на `sql.js` (WASM) — собирается в Docker-образе n8n без нативной компиляции.
  Подходит, когда у коллег нет своей MySQL. Ограничение: store локален для этого инстанса n8n
  (не шарится по сети между несколькими серверами).
- **MySQL** — централизованное хранилище, общее для нескольких инстансов n8n, с возможностью
  дать каждому свой MySQL-логин.

Вся логика (аккаунты, `shared`, AES-шифрование, операции) одинакова для обоих бэкендов.

> SQLite-файл держи на смонтированном volume (`~/.n8n`), иначе данные не переживут пересоздание контейнера.

## Возможности

- **Операции:** Get, Get All Keys, Set (upsert), Create, Update, Delete, Clear (обнулить значение).
- **Мультиаккаунтность:** у каждого свой `Account` в credential. Переменные изолированы по владельцу.
- **Shared-переменные:** флаг `shared` — читают все аккаунты, но **править/удалять может только создатель**.
- **Шифрование at rest:** значения шифруются AES-256-GCM перед записью; в БД лежит шифротекст.
- **Типы значений:** String и JSON.
- **Usable as Tool:** ноду можно подключать к AI-агентам n8n.

## Модель доступа

- Владелец переменной = поле **Account** в credential.
- Уникальность ключа: **`(owner, key)`** — два аккаунта могут иметь свой `stripe_key` независимо.
- `Get` отдаёт сначала собственную переменную, затем (если своей нет) `shared`-переменную с таким ключом.
- Все операции записи (`set`/`create`/`update`/`delete`/`clear`) работают только со строками `owner = <ваш Account>`. Поэтому чужие `shared`-переменные доступны только на чтение.

> ⚠️ **Важно про shared + шифрование.** Значения шифруются ключом из credential.
> Чтобы `shared`-переменные **читались всеми аккаунтами**, у всех должен быть **одинаковый `Encryption Key`**.
> Приватные переменные могут использовать любой ключ (их всё равно читает только владелец).

## Схема таблицы

Создаётся автоматически (`Auto-create Table` = on). SQL для ручного создания:

```sql
CREATE TABLE IF NOT EXISTS `n8n_variables` (
  `owner`      VARCHAR(190) NOT NULL,
  `key`        VARCHAR(190) NOT NULL,
  `value`      LONGTEXT NULL,
  `type`       VARCHAR(20) NOT NULL DEFAULT 'string',
  `encrypted`  TINYINT(1) NOT NULL DEFAULT 1,
  `shared`     TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`owner`, `key`),
  KEY `idx_shared` (`shared`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Рекомендуемые гранты (least privilege)

Дайте каждому человеку свой MySQL-логин с правами только на таблицу переменных:

```sql
CREATE USER 'alice'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON `n8n`.`n8n_variables` TO 'alice'@'%';
-- при Auto-create Table нужен также CREATE:
GRANT CREATE ON `n8n`.* TO 'alice'@'%';
```

## Сборка

```bash
npm install
npm run build      # -> dist/
```

## Установка в n8n (Docker, self-hosted)

### Вариант A — локальная папка custom (быстро, без публикации в npm)

```bash
# 1. Собрать и упаковать
npm install && npm run build
npm pack            # -> n8n-nodes-mysql-variables-0.1.0.tgz

# 2. Поставить в папку custom, которая монтируется в контейнер
mkdir -p ~/n8n-data/custom
cd ~/n8n-data/custom
npm init -y
npm install /полный/путь/n8n-nodes-mysql-variables-0.1.0.tgz   # подтянет mysql2
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

n8n автоматически подхватит ноду из `~/.n8n/custom`. После рестарта она появится в палитре как **MySQL Variables**.

### Вариант B — свой Docker-образ (для прода)

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

### docker-compose (пример)

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

> После публикации пакета в npm его можно ставить и через GUI:
> **Settings → Community nodes → Install → `n8n-nodes-mysql-variables`**.

## Настройка credential

В n8n создайте credential **MySQL Variables API**:

| Поле | Описание |
|---|---|
| **Storage** | `SQLite (embedded)` или `MySQL`. |
| **Account** | Уникальное имя владельца (например, `alice`). Определяет изоляцию. |
| **Encryption Key** | Ключ AES. Для общих переменных — одинаковый у всех. |
| SQLite File Path | Только для SQLite. Пусто = `<user folder>/n8n-mysql-variables.sqlite`. |
| Host / Port / Database / User / Password / SSL | Только для MySQL. В Docker `localhost` ≠ хост — см. ниже. |
| Table Name | По умолчанию `n8n_variables`. |
| Auto-create Table | Создавать таблицу автоматически. |

> **Docker + MySQL:** `localhost` внутри контейнера n8n указывает на сам контейнер.
> Используй имя сервиса/контейнера MySQL (общая docker-сеть) либо `host.docker.internal`
> для базы на хост-машине. Это причина ошибки `connect ECONNREFUSED ::1:3306`.

## Использование в выражениях

```js
// получить значение переменной из ноды MySQL Variables
{{ $('MySQL Variables').item.json.value }}
```

Типичный паттерн: нода **MySQL Variables (Get)** в начале workflow → дальше значение
используется в HTTP Request / прочих нодах через выражение выше.

## Операции

| Операция | Что делает | Скоуп |
|---|---|---|
| **Get Variable** | Читает значение по ключу (своя → затем shared) | own + shared |
| **Get All Keys** | Список ключей (фильтр All/Mine/Shared, опц. значения) | own + shared |
| **Set Variable** | Upsert (создать или обновить) | только own |
| **Create Variable** | Вставить, ошибка если уже есть | только own |
| **Update Variable** | Обновить, ошибка если нет | только own |
| **Delete Variable** | Удалить ключ целиком | только own |
| **Clear Variable** | Обнулить значение, ключ оставить | только own |

## Лицензия

MIT

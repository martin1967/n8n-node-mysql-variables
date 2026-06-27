# n8n-nodes-mysql-variables

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

## Хранилище: SQLite или MySQL

В credential поле **Storage** переключает бэкенд:

- **SQLite (embedded)** — по умолчанию. Никакого сервера БД, ничего настраивать не надо.
  Данные лежат в файле внутри папки данных n8n; путь к файлу подбирается **автоматически**
  по `Username`/ключу (см. «Изоляция и шеринг»).
  Реализовано на `sql.js` (WASM) — собирается в Docker-образе n8n без нативной компиляции.
  Подходит, когда у коллег нет своей MySQL. Ограничение: store локален для этого инстанса n8n
  (не шарится по сети между несколькими серверами).
- **MySQL** — централизованное хранилище, общее для нескольких инстансов n8n, с возможностью
  дать каждому свой MySQL-логин.

Логика (плоский key→value, AES-шифрование, операции) одинакова для обоих бэкендов.

> SQLite-файл держи на смонтированном volume (`~/.n8n`), иначе данные не переживут пересоздание контейнера.

## Возможности

- **Операции:** Get, Get All Keys, Set (upsert), Create, Update, Delete, Clear (обнулить значение).
- **Плоский key→value:** один store = один файл SQLite (или одна таблица MySQL). Ключ уникален в рамках store.
- **Шифрование at rest:** значения шифруются AES-256-GCM перед записью; в БД лежит шифротекст.
- **Типы значений:** String и JSON.
- **Usable as Tool:** ноду можно подключать к AI-агентам n8n.

## Изоляция и шеринг (SQLite)

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

## Схема таблицы

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
| **Encryption Key** | Ключ AES **и секрет доступа к стору** (из него выводится файл). |
| Username | Только SQLite. Метка стора (не секрет). Пусто → один стор на ключ. |
| Advanced: Custom File Path → SQLite File Path | Только SQLite, для профи: явный путь к файлу. |
| Host / Port / Database / User / Password / SSL | Только MySQL. В Docker `localhost` ≠ хост — см. ниже. |
| Table Name | Только MySQL. Изоляция — своя таблица/БД на credential. |
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

| Операция | Что делает |
|---|---|
| **Get Variable** | Читает значение по ключу |
| **Get All Keys** | Список всех ключей (опц. со значениями) |
| **Set Variable** | Upsert (создать или обновить) |
| **Create Variable** | Вставить, ошибка если уже есть |
| **Update Variable** | Обновить, ошибка если нет |
| **Delete Variable** | Удалить ключ целиком |
| **Clear Variable** | Обнулить значение, ключ оставить |

## Лицензия

MIT

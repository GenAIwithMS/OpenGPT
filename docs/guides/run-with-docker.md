# Run with Docker

The image `genaiwithms/opengpt` holds the backend, the built frontend and the
coding agent. MySQL runs as a second container. Nothing secret is in the
image: settings come from `backend/.env` and environment variables.

## Start

```bash
git clone https://github.com/GenAIwithMS/OpenGPT.git && cd OpenGPT
cp backend/.env.example backend/.env    # set LLM_* (your model provider) at least
docker compose up -d
```

Open **http://localhost:8000**. The first start takes a minute while MySQL
sets itself up.

You can also skip `backend/.env` and add a provider later in Settings >
Developer, but the backend needs a working model at startup, so set `LLM_*`
in one of the two.

## What `docker-compose.yml` does

- Runs `genaiwithms/opengpt` and `mysql:8.4`, and connects them. The database
  settings in the compose file override any `MYSQL_*` in `backend/.env`.
- Publishes the app on **127.0.0.1:8000** only. Change the port with
  `OPENGPT_PORT=9000 docker compose up -d`.
- Keeps data in named volumes: `opengpt-storage` (uploads, the encryption
  key for stored secrets, logs), `opengpt-data` (coding agent projects,
  downloaded embedding model) and `mysql-data`.
- The database password defaults to `opengpt`. MySQL isn't published outside
  Docker, but you can set your own: `OPENGPT_DB_PASSWORD=... docker compose up -d`
  (use the same value every time).

## Update

```bash
docker compose pull && docker compose up -d
```

A new image is published for every change to `main` that passes the tests:
`genaiwithms/opengpt:latest`, and `genaiwithms/opengpt:sha-<commit>` to pin
an exact version (set `image:` in `docker-compose.yml`).

## Local models

Inside the container, `localhost` is the container itself. A model server on
your computer is at `http://host.docker.internal:<port>/v1`, for example
`http://host.docker.internal:11434/v1` for Ollama. Add it with Settings >
Developer > Add provider (change the base URL), or set `LLM_BASE_URL`.

Find local models can't see servers or model folders on your computer from
inside the container. The server must also listen on more than 127.0.0.1
(for Ollama: `OLLAMA_HOST=0.0.0.0`).

## The coding agent

The Code page works on folders in the `opengpt-data` volume
(`/data/projects`). To work on folders from your computer, mount them there,
for example under `volumes:` add `- ./my-projects:/data/projects`.

## Open it to your network

The app treats itself as local because the port is published on 127.0.0.1.
To use it from other devices:

1. In `backend/.env` set `HOST=0.0.0.0` and a long random `API_TOKEN`.
2. In `docker-compose.yml` change the port to `"8000:8000"`.

With `API_TOKEN` set, every API call needs the token, and the page in this
image doesn't send one. Put the app behind a reverse proxy that asks people
to sign in and adds the `Authorization: Bearer <token>` header. The coding
agent is off in this mode unless you set `CODING_AGENT_ENABLED=true`.
Never publish the port to the network without `API_TOKEN`.

## Without compose

```bash
docker run -d -p 127.0.0.1:8000:8000 --env-file backend/.env \
  -e MYSQL_HOST=<your MySQL host> \
  -v opengpt-storage:/app/backend/app/storage -v opengpt-data:/data \
  genaiwithms/opengpt
```

Always publish with `127.0.0.1:` in front, unless you followed "Open it to
your network".

## Build the image yourself

```bash
docker build -t opengpt .
```

How the image works: [Dockerfile](../../Dockerfile).

## How the published image is built

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the backend
tests, the frontend build, the coding agent type check and the browser
engine tests on every push to
`main` and every pull request. After a push to `main` passes, it builds the
image (linux/amd64) and pushes it to Docker Hub as `latest` and
`sha-<commit>`. It needs two repository secrets: `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` (a Docker Hub access token with read and write access). The backend serves the
built frontend itself when `FRONTEND_DIST` is set, and listens on
`BIND_HOST` (0.0.0.0) inside the container while `HOST` stays local.

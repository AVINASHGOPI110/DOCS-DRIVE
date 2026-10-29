# Docs Drive

A small, self-hosted personal file locker. Users can create an account, sign in, upload files, browse/search them, star items, download them, and delete them.

## Current limits

- Per account: 1 GiB (1,073,741,824 bytes)
- Per file: strictly less than 100 MiB (104,857,600 bytes)
- Runtime: Node.js 24 or the included Docker image
- Database: SQLite
- File storage: local persistent volume/directory

## Run locally

Requires Node.js 24 or later.

```sh
node server.mjs
```

Open `http://127.0.0.1:3000`. By default, the app binds to `127.0.0.1` and stores its database and uploads in `.docs-drive-data/` beside the server file. Set `HOST`, `PORT`, or `DOCS_DRIVE_DATA_DIR` to override those defaults.

## Run with Docker

Build the image from this directory:

```sh
docker build -t docs-drive .
```

Run with a persistent volume so uploaded files and the SQLite database survive container replacement:

```sh
docker volume create docs-drive-data
docker run -d --name docs-drive \
  --restart unless-stopped \
  -p 3000:3000 \
  -v docs-drive-data:/data \
  docs-drive
```

Open `http://localhost:3000` on the host. For internet access, put the service behind a trusted HTTPS reverse proxy or a hosting platform that provides HTTPS. Do not expose a plain-HTTP login page to the public internet.

## Deployment checklist

- [ ] Configure HTTPS before allowing public sign-ins.
- [ ] Attach persistent storage at `/data`; verify it survives a redeploy.
- [ ] Back up both `/data/docs-drive.sqlite` and `/data/uploads/` together, and test restoring them.
- [ ] Keep the host and Node.js image updated.
- [ ] Monitor disk space, CPU, memory, and application logs.
- [ ] Test account isolation with two separate test accounts.
- [ ] Test maximum-size files and account-quota edge cases.
- [ ] Confirm the hosting provider does not impose request/body limits below the app's file limit.

## Important limitations before a public launch

This is a personal project baseline, not a security-audited cloud storage service. It does not currently include password reset/email verification, malware scanning, end-to-end encryption, automated backups, multi-region replication, or a distributed rate limiter. Uploaded files are stored on the server's filesystem and are not end-to-end encrypted. The built-in login rate limiter is in-memory and intended for a single server instance. Do not use it for sensitive or irreplaceable files until you have tested backups and reviewed the deployment security.

The `/health` endpoint is intended for hosting health checks and returns only service status.

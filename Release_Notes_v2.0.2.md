# GyroidVault v2.0.2 — Stability & Performance Release

**Release Date:** September 13, 2026

This release focuses on large-library performance, memory safety, and operational observability for Docker and Unraid users:

### 🚀 Performance & Memory Fixes

- **Folder Browsing 100% CPU Lock Resolved (#59)**:
  - Added SQLite B-Tree index on `files(library_path)`.
  - Removed full-database in-memory file maps that loaded 50,000+ records into JavaScript memory on every directory click.
  - Replaced $O(N \times M)$ nested JavaScript loops with targeted, indexed queries for folder collage thumbnails, reducing directory loading time from several seconds of 100% CPU lock down to <1ms.

- **Duplicate Scanner Out-of-Memory (OOM) Crash Resolved (#58)**:
  - Replaced synchronous `fs.readFileSync` with non-blocking, chunk-streaming SHA-256 hashing (`fs.createReadStream` with 64KB buffers).
  - Memory consumption during hashing is now locked to <1MB regardless of file size, permanently preventing Docker OOM `SIGKILL` (Exit code 137) when scanning large STLs, 3MFs, or multi-gigabyte G-code toolpaths.
  - Added cooperative event-loop yielding (`setImmediate`) to ensure the web UI and Docker healthchecks remain completely responsive during deep library scans.
  - Query optimization: SQLite now groups files by `file_size` at the database engine level, only scanning file sizes that actually contain duplicates.

### 📋 Operational Logging & Observability

- **Structured Console Logs for Docker / Unraid**:
  - All server output now includes standard timestamps and severity tags: `[YYYY-MM-DD HH:mm:ss] [LEVEL] [Tag] Message`.
  - **HTTP Request Logger**: Automatically logs incoming API requests with HTTP method, endpoint, status code, and latency in milliseconds.
  - **Duplicate & Background Task Tracking**: Emits clear start, candidate count, hashing progress, and completion statistics to stdout.
  - **Crash Diagnostics**: Global handlers for `uncaughtException` and `unhandledRejection` now print complete error stack traces to container logs before process termination.
  - **Configurable `LOG_LEVEL`**: Supports `LOG_LEVEL=debug` for detailed troubleshooting in Unraid/Docker environments.

# Video Downloader Website

Simple local website that accepts a video URL, reads available formats with `yt_dlp`, and returns a downloadable file at the closest supported resolution.

## Run

```powershell
node server.js
```

Then open `http://localhost:3000`.

## Notes

- This project uses Python's installed `yt_dlp` module via `python -m yt_dlp`.
- The current setup does not use `ffmpeg`, so it prefers single-file downloadable formats.
- Some websites may not expose every requested quality as a standalone stream.

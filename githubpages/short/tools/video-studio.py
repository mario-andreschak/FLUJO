#!/usr/bin/env python3
"""Local FLUJO Video Studio server.

Serves the film and studio UI, persists the editable project, calls the
ElevenLabs MCP server through FLUJO, fits scene audio to the film timeline, and
publishes the voice/caption runtime manifest consumed by app.js.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PROJECT_PATH = ROOT / "studio" / "project.json"
CONTENT_PATH = ROOT / "film-content.js"
PROXY_URL = "http://localhost:4200/mcp-proxy/mcp-server-elevenlabs"
SAFE_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def validate_project(project: dict[str, Any]) -> None:
    if not isinstance(project.get("voices"), list) or not project["voices"]:
        raise ValueError("The project needs at least one voice.")
    if not isinstance(project.get("scenes"), list) or not project["scenes"]:
        raise ValueError("The project needs at least one scene.")
    if not isinstance(project.get("captionTracks"), dict):
        raise ValueError("captionTracks must be an object.")
    keys: set[str] = set()
    for voice in project["voices"]:
        key = str(voice.get("key", ""))
        if not SAFE_KEY.fullmatch(key):
            raise ValueError(f"Invalid voice key: {key!r}")
        if key in keys:
            raise ValueError(f"Duplicate voice key: {key}")
        keys.add(key)
        if not voice.get("name") or not voice.get("source"):
            raise ValueError(f"Voice {key} needs a name and output source.")
    if project.get("defaultVoice") not in keys:
        project["defaultVoice"] = project["voices"][0]["key"]


def voice_by_key(project: dict[str, Any], key: str) -> dict[str, Any]:
    if not SAFE_KEY.fullmatch(key):
        raise ValueError("Invalid voice key.")
    for voice in project["voices"]:
        if voice["key"] == key:
            return voice
    raise ValueError(f"Unknown voice: {key}")


def scene_by_id(project: dict[str, Any], scene_id: int) -> dict[str, Any]:
    for scene in project["scenes"]:
        if int(scene["id"]) == int(scene_id):
            return scene
    raise ValueError(f"Unknown scene: {scene_id}")


def project_status(project: dict[str, Any]) -> dict[str, Any]:
    status: dict[str, Any] = {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "voices": {},
    }
    for voice in project["voices"]:
        key = voice["key"]
        raw_dir = ROOT / "assets" / "audio" / "voice-scenes" / key
        if key == "brian":
            for scene in project["scenes"]:
                scene_id = int(scene["id"])
                target = raw_scene_path(key, scene_id)
                if not target.is_file():
                    bootstrap_legacy_brian(scene_id, target)
        raw_scenes = [
            int(match.group(1))
            for item in raw_dir.glob("scene-*-raw.mp3")
            if (match := re.match(r"scene-(\d+)-raw\.mp3$", item.name))
        ]
        output = (ROOT / voice["source"]).resolve()
        status["voices"][key] = {
            "rawScenes": sorted(raw_scenes),
            "trackExists": output.is_file(),
            "trackBytes": output.stat().st_size if output.is_file() else 0,
        }
    return status


def parse_rpc_response(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if raw.startswith("event:") or "\ndata:" in raw:
        data_lines = [
            line[5:].strip()
            for line in raw.splitlines()
            if line.startswith("data:")
        ]
        if not data_lines:
            raise RuntimeError("The MCP proxy returned an empty event stream.")
        raw = data_lines[-1]
    response = json.loads(raw)
    if response.get("error"):
        raise RuntimeError(response["error"].get("message", "MCP request failed."))
    return response


def mcp_call(name: str, arguments: dict[str, Any], request_id: int = 1) -> dict[str, Any]:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        PROXY_URL,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            rpc = parse_rpc_response(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        raise RuntimeError(
            "FLUJO's ElevenLabs MCP proxy is unavailable on localhost:4200."
        ) from error
    content = rpc.get("result", {}).get("content", [])
    if not content:
        return rpc.get("result", {})
    text = content[0].get("text", "{}")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}


def run(command: list[str]) -> None:
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(detail[-1800:] or f"{command[0]} failed.")


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


def atempo_filter(tempo: float) -> str:
    parts: list[str] = []
    while tempo > 2:
        parts.append("atempo=2")
        tempo /= 2
    while tempo < 0.5:
        parts.append("atempo=0.5")
        tempo /= 0.5
    parts.append(f"atempo={tempo:.8f}")
    return ",".join(parts)


def raw_scene_path(voice_key: str, scene_id: int) -> Path:
    return (
        ROOT
        / "assets"
        / "audio"
        / "voice-scenes"
        / voice_key
        / f"scene-{scene_id:02d}-raw.mp3"
    )


def bootstrap_legacy_brian(scene_id: int, target: Path) -> bool:
    legacy = ROOT / "assets" / "audio" / f"voiceover-scene-{scene_id:02d}.mp3"
    if legacy.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(legacy, target)
        return True
    return False


def generate_scene(
    project: dict[str, Any],
    voice: dict[str, Any],
    scene: dict[str, Any],
    request_id: int,
) -> Path:
    language = voice.get("language", project.get("defaultLanguage", "en"))
    text = scene.get("scripts", {}).get(language, "").strip()
    if not text:
        raise ValueError(
            f"Scene {scene['id']} has no script for "
            f"{project.get('languages', {}).get(language, {}).get('name', language)}."
        )
    voice_id = str(voice.get("voiceId", "")).strip()
    if not voice_id:
        raise ValueError(f"{voice['name']} needs an ElevenLabs voice ID.")
    payload = mcp_call(
        "generate_speech",
        {
            "text": text,
            "voice_id": voice_id,
            "model_id": voice.get("modelId", "eleven_v3"),
            "stability": float(voice.get("stability", 0.42)),
            "similarity_boost": float(voice.get("similarityBoost", 0.8)),
            "output_format": "mp3_44100_128",
        },
        request_id,
    )
    generated = payload.get("file_path")
    if not payload.get("ok", True) or not generated:
        raise RuntimeError(payload.get("message", "ElevenLabs did not return audio."))
    source = Path(generated)
    if not source.is_file():
        raise RuntimeError("The generated ElevenLabs audio file could not be found.")
    target = raw_scene_path(voice["key"], int(scene["id"]))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return target


def render_voice_track(project: dict[str, Any], voice: dict[str, Any]) -> dict[str, Any]:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe must be available on PATH.")

    scenes = project["scenes"]
    missing: list[int] = []
    for scene in scenes:
        scene_id = int(scene["id"])
        raw = raw_scene_path(voice["key"], scene_id)
        if not raw.is_file() and voice["key"] == "brian":
            bootstrap_legacy_brian(scene_id, raw)
        if not raw.is_file():
            missing.append(scene_id)
    if missing:
        raise ValueError(
            "Generate or replace these missing scenes first: "
            + ", ".join(map(str, missing))
        )

    output = (ROOT / voice["source"]).resolve()
    if ROOT.resolve() not in output.parents:
        raise ValueError("Voice output must stay inside the project.")
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"flujo-studio-{voice['key']}-") as temp:
        build = Path(temp)
        fitted: list[Path] = []
        for scene in scenes:
            scene_id = int(scene["id"])
            source = raw_scene_path(voice["key"], scene_id)
            target_duration = float(scene["duration"])
            tempo = probe_duration(source) / target_duration
            fitted_path = build / f"scene-{scene_id:02d}.wav"
            run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source),
                    "-af",
                    f"{atempo_filter(tempo)},apad=pad_dur={target_duration:.8f}",
                    "-t",
                    f"{target_duration:.8f}",
                    "-ar",
                    "44100",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(fitted_path),
                ]
            )
            fitted.append(fitted_path)

        gap = build / "gap.wav"
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono",
                "-t",
                str(float(project.get("sceneGap", 1.2))),
                "-c:a",
                "pcm_s16le",
                str(gap),
            ]
        )
        concat_file = build / "concat.txt"
        concat_lines: list[str] = []
        for index, fitted_path in enumerate(fitted):
            concat_lines.append(f"file '{fitted_path.as_posix()}'")
            if index < len(fitted) - 1:
                concat_lines.append(f"file '{gap.as_posix()}'")
        concat_file.write_text("\n".join(concat_lines), encoding="utf-8")
        combined = build / "combined.wav"
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c:a",
                "pcm_s16le",
                str(combined),
            ]
        )
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(combined),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=7",
                "-ar",
                "44100",
                "-ac",
                "1",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(output),
            ]
        )

    duration = probe_duration(output)
    metadata = {
        "voiceKey": voice["key"],
        "voiceName": voice["name"],
        "voiceId": voice.get("voiceId", ""),
        "language": voice.get("language", "en"),
        "modelId": voice.get("modelId", "eleven_v3"),
        "targetDuration": project["voiceoverEnd"],
        "finalDuration": duration,
        "outputFile": output.name,
    }
    write_json(output.parent / "voice-scenes" / voice["key"] / "metadata.json", metadata)
    return {"source": voice["source"], "duration": duration, "bytes": output.stat().st_size}


def publish_content(project: dict[str, Any]) -> None:
    languages = project.get("languages", {})
    voices = {
        voice["key"]: {
            "name": voice["name"],
            "source": voice["source"],
            "language": voice.get("language", project.get("defaultLanguage", "en")),
        }
        for voice in project["voices"]
    }
    content = {
        "version": project.get("version", 1),
        "defaultVoice": project["defaultVoice"],
        "defaultLanguage": project.get("defaultLanguage", "en"),
        "languages": languages,
        "voices": voices,
        "captionTracks": project.get("captionTracks", {}),
    }
    temporary = CONTENT_PATH.with_suffix(".js.tmp")
    temporary.write_text(
        "window.FLUJO_STUDIO = "
        + json.dumps(content, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    os.replace(temporary, CONTENT_PATH)


class StudioHandler(SimpleHTTPRequestHandler):
    server_version = "FLUJOStudio/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[studio] {self.address_string()} — {format % args}")

    def send_json(self, payload: Any, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 30 * 1024 * 1024:
            raise ValueError("Request is too large.")
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/studio":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/studio/")
            self.end_headers()
            return
        if path == "/api/project":
            project = read_json(PROJECT_PATH)
            self.send_json({"project": project, "status": project_status(project)})
            return
        if path == "/api/elevenlabs/voices":
            try:
                payload = mcp_call("list_voices", {"page_size": 100}, 901)
                self.send_json({"ok": True, "payload": payload})
            except Exception as error:
                self.send_json({"ok": False, "error": str(error)}, 502)
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            body = self.read_body()
            path = self.path.split("?", 1)[0]
            if path in {"/api/save", "/api/publish"}:
                project = body.get("project", body)
                validate_project(project)
                write_json(PROJECT_PATH, project)
                if path == "/api/publish":
                    publish_content(project)
                self.send_json(
                    {
                        "ok": True,
                        "message": "Published to the film." if path.endswith("publish") else "Project saved.",
                    }
                )
                return

            project = read_json(PROJECT_PATH)
            if path == "/api/generate":
                voice = voice_by_key(project, str(body.get("voiceKey", "")))
                requested = {int(item) for item in body.get("sceneIds", [])}
                missing = {
                    int(scene["id"])
                    for scene in project["scenes"]
                    if not raw_scene_path(voice["key"], int(scene["id"])).is_file()
                }
                if voice["key"] == "brian":
                    for scene_id in list(missing):
                        if bootstrap_legacy_brian(
                            scene_id, raw_scene_path(voice["key"], scene_id)
                        ):
                            missing.remove(scene_id)
                targets = sorted(requested | missing)
                if not targets:
                    raise ValueError("Select at least one scene to regenerate.")
                generated: list[int] = []
                for offset, scene_id in enumerate(targets):
                    generate_scene(
                        project,
                        voice,
                        scene_by_id(project, scene_id),
                        1100 + offset,
                    )
                    generated.append(scene_id)
                track = render_voice_track(project, voice)
                self.send_json(
                    {
                        "ok": True,
                        "message": f"Generated {len(generated)} scene(s) and rebuilt {voice['name']}.",
                        "generated": generated,
                        "track": track,
                        "status": project_status(project),
                    }
                )
                return

            if path == "/api/render":
                voice = voice_by_key(project, str(body.get("voiceKey", "")))
                track = render_voice_track(project, voice)
                self.send_json(
                    {
                        "ok": True,
                        "message": f"Rebuilt {voice['name']} from existing scene audio.",
                        "track": track,
                        "status": project_status(project),
                    }
                )
                return

            if path == "/api/replace-section":
                voice = voice_by_key(project, str(body.get("voiceKey", "")))
                scene_id = int(body.get("sceneId", 0))
                scene_by_id(project, scene_id)
                encoded = str(body.get("data", ""))
                if "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                audio = base64.b64decode(encoded, validate=True)
                if not audio or len(audio) > 25 * 1024 * 1024:
                    raise ValueError("Replacement audio must be between 1 byte and 25 MB.")
                target = raw_scene_path(voice["key"], scene_id)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(audio)
                track = render_voice_track(project, voice)
                self.send_json(
                    {
                        "ok": True,
                        "message": f"Replaced scene {scene_id} and rebuilt {voice['name']}.",
                        "track": track,
                        "status": project_status(project),
                    }
                )
                return

            self.send_json({"ok": False, "error": "Unknown API endpoint."}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"ok": False, "error": str(error)}, 400)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, 500)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the FLUJO Video Studio.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8766, type=int)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    print(f"FLUJO Video Studio: http://{args.host}:{args.port}/studio/")
    print(f"Film preview:       http://{args.host}:{args.port}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

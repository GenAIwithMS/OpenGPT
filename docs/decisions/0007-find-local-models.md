# 0007. Find local models by port and by the apps' own folders

Status: accepted (2026-11-19)

## Context

OpenGPT already worked with local model servers (Ollama and LM Studio
presets, or Custom), but people had to know which server they run, its port,
and that it must be running. A failed connection only said "Couldn't reach
localhost:11434", even when the user had models downloaded and had only
forgotten to start the server.

## Decision

Settings > Developer > **Find local models** checks two things for Ollama,
LM Studio, llama.cpp and Jan:

- the server's usual port on 127.0.0.1, for running servers and their models;
- each app's own model folder, and whether the app is installed, so it can
  say "you have these models downloaded, start the server" or "download a
  model first".

Limits:

- Only known folders that belong to each app. No disk-wide search: there is
  no standard folder for raw model files, and searching the disk is slow and
  intrusive. Servers without a known folder are found by port only.
- Names and sizes only; model files are never opened.
- The folder and PATH checks run only while `HOST` is local, because then the
  backend's disk is the user's own machine and the API isn't on the network.
- OpenGPT never starts a server; the message gives the command.

Known model errors in chat (no tool calling, context too long, model not
found, server not reachable) get a fixed message instead of "Something went
wrong", since these are the usual problems with local models.

## Consequences

- Adding a local model is a search and one click.
- A new local server needs an entry in `SERVERS` (and `_folders`) in
  `app/services/local_models.py`, as well as a preset.
- A server on a non-default port is not found by the search; Custom still
  works for it, and Ollama's `OLLAMA_HOST` port is respected.

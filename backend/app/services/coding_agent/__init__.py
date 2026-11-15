"""Coding agent integration: the agent service the Code page talks to.

The agent runs as a separate process (coding-agent/, Bun). The backend starts
and stops it (`process.agent`) and passes requests through to it.
"""

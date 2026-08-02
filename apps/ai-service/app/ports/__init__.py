"""Ports package — structural interfaces (Protocols) for external dependencies.

A "port" is a seam where an adapter plugs in. Routes depend on these, not on
concrete clients, so we can swap fakes in tests without monkeypatching.
"""

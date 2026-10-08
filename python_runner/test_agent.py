#!/usr/bin/env python3
"""
Unit tests for python_runner/agent.py pure helpers (clean_base_url, argument resolution).
Runs standalone without requiring Playwright or network connections.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent import clean_base_url, build_arg_parser, resolve_args, validate_args

class TestPythonRunner(unittest.TestCase):
    def test_clean_base_url_table(self):
        cases = [
            ("https://build.nvidia.com", "https://integrate.api.nvidia.com"),
            ("https://build.nvidia.com/", "https://integrate.api.nvidia.com"),
            ("https://build.nvidia.com/v1", "https://integrate.api.nvidia.com"),
            ("https://build.nvidia.com/v1/chat/completions", "https://integrate.api.nvidia.com"),
            ("https://integrate.api.nvidia.com/v1/chat/completions", "https://integrate.api.nvidia.com"),
            ("https://integrate.api.nvidia.com/v1/models", "https://integrate.api.nvidia.com"),
            ("https://integrate.api.nvidia.com/v1", "https://integrate.api.nvidia.com"),
            ("https://api.openai.com/v1/chat/completions", "https://api.openai.com"),
            ("https://api.openai.com/v1", "https://api.openai.com"),
            ("http://localhost:11434/", "http://localhost:11434"),
            ("http://localhost:11434", "http://localhost:11434"),
        ]
        for inp, expected in cases:
            with self.subTest(inp=inp):
                self.assertEqual(clean_base_url(inp), expected)

    def test_default_timeouts(self):
        parser = build_arg_parser()
        
        # NVIDIA default timeout should be 300s
        args_nvidia = resolve_args(parser.parse_args(["--provider", "nvidia"]), environ={})
        self.assertEqual(args_nvidia.timeout, 300)
        
        # OpenAI default timeout should be 120s
        args_openai = resolve_args(parser.parse_args(["--provider", "openai"]), environ={})
        self.assertEqual(args_openai.timeout, 120)

        # Ollama default timeout should be 120s
        args_ollama = resolve_args(parser.parse_args(["--provider", "ollama"]), environ={})
        self.assertEqual(args_ollama.timeout, 120)

        # Explicit timeout overrides provider default
        args_custom = resolve_args(parser.parse_args(["--provider", "nvidia", "--timeout", "450"]), environ={})
        self.assertEqual(args_custom.timeout, 450)

    def test_api_key_from_environ(self):
        parser = build_arg_parser()
        env = {
            "NVIDIA_API_KEY": "nvapi-test-key",
            "OPENAI_API_KEY": "sk-test-key"
        }

        args_nvidia = resolve_args(parser.parse_args(["--provider", "nvidia"]), environ=env)
        self.assertEqual(args_nvidia.api_key, "nvapi-test-key")

        args_openai = resolve_args(parser.parse_args(["--provider", "openai"]), environ=env)
        self.assertEqual(args_openai.api_key, "sk-test-key")

        # Explicit --api-key takes precedence over environ
        args_override = resolve_args(parser.parse_args(["--provider", "nvidia", "--api-key", "explicit-key"]), environ=env)
        self.assertEqual(args_override.api_key, "explicit-key")

    def test_validate_args(self):
        parser = build_arg_parser()

        args_list = resolve_args(parser.parse_args(["--provider", "nvidia", "--list-models"]), environ={})
        validate_args(args_list)

        args_no_key = resolve_args(parser.parse_args(["--provider", "nvidia"]), environ={})
        with self.assertRaises(ValueError):
            validate_args(args_no_key)

        args_ollama = resolve_args(parser.parse_args(["--provider", "ollama"]), environ={})
        validate_args(args_ollama)

        args_leak = resolve_args(parser.parse_args(["--provider", "nvidia", "--api-key", "key", "--base-url", "http://localhost:11434"]), environ={})
        with self.assertRaises(ValueError):
            validate_args(args_leak)

if __name__ == "__main__":
    unittest.main()

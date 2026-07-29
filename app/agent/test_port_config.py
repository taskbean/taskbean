from __future__ import annotations

import port_config


def test_runtime_port_prefers_taskbean_env() -> None:
    env = {"TASKBEAN_PORT": "9001", "PORT": "4567"}

    info = port_config.resolve_runtime_port(env=env, config_get=lambda key: None)

    assert info.port == 9001
    assert info.source == "env:TASKBEAN_PORT"


def test_runtime_port_uses_portless_port_when_no_taskbean_override() -> None:
    env = {"PORT": "4567"}

    info = port_config.resolve_runtime_port(env=env, config_get=lambda key: None)

    assert info.port == 4567
    assert info.source == "env:PORT"


def test_runtime_port_ignores_invalid_env_and_uses_saved_config() -> None:
    env = {"TASKBEAN_PORT": "nope", "taskbean_PORT": "99999", "PORT": "0"}

    info = port_config.resolve_runtime_port(env=env, config_get=lambda key: 6123 if key == "port" else None)

    assert info.port == 6123
    assert info.source == "config"


def test_port_info_prefers_configured_public_url() -> None:
    info = port_config.build_port_info(
        env={},
        config_get=lambda key: "https://custom.localhost" if key == "publicBaseUrl" else None,
        portless_detected=True,
    )

    assert info["publicUrl"] == "https://custom.localhost"
    assert info["portlessUrl"] == "https://taskbean.localhost"
    assert info["fallbackUrl"] == "http://127.0.0.1:8275"


def test_port_info_uses_launch_public_url_when_config_is_unset() -> None:
    info = port_config.build_port_info(
        env={"PORTLESS_URL": "https://taskbean.localhost/"},
        config_get=lambda key: None,
        portless_detected=False,
    )

    assert info["publicUrl"] == "https://taskbean.localhost"


def test_port_info_uses_portless_url_when_portless_sets_runtime_port() -> None:
    info = port_config.build_port_info(env={"PORT": "5555"}, config_get=lambda key: None, portless_detected=True)

    assert info["publicUrl"] == "https://taskbean.localhost"
    assert info["portlessDetected"] is True
    assert info["source"] == "env:PORT"


def test_port_info_does_not_advertise_portless_url_for_manual_launch() -> None:
    info = port_config.build_port_info(env={}, config_get=lambda key: None, portless_detected=True)

    assert info["publicUrl"] == "http://127.0.0.1:8275"
    assert info["portlessDetected"] is True
    assert info["source"] == "default"


def test_port_info_falls_back_to_loopback_without_portless() -> None:
    info = port_config.build_port_info(env={}, config_get=lambda key: None, portless_detected=False)

    assert info["publicUrl"] == "http://127.0.0.1:8275"
    assert info["portlessDetected"] is False

import contextlib
import json
import os
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=True, default=str))


def json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    if hasattr(value, "to_dict"):
        try:
            return json_safe(value.to_dict(orient="records"))
        except TypeError:
            return json_safe(value.to_dict())
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return str(value)


def load_tq(initialize=True):
    tdx_home = Path(os.environ.get("TDX_HOME", r"C:\new_tdx"))
    user_dir = tdx_home / "PYPlugins" / "user"
    tqcenter_path = user_dir / "tqcenter.py"

    if not tqcenter_path.exists():
        return None, {
            "available": False,
            "reason": "tqcenter_missing",
            "tdxHome": str(tdx_home),
            "expectedPath": str(tqcenter_path),
            "message": "已检测到通达信目录，但当前版本未安装 TdxQuant/PYPlugins 组件。",
        }

    sys.path.insert(0, str(user_dir))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from tqcenter import tq

            if initialize:
                tq.initialize(str(Path(__file__).resolve()))
        return tq, {
            "available": True,
            "reason": "ready",
            "tdxHome": str(tdx_home),
            "tqcenterPath": str(tqcenter_path),
        }
    except Exception as error:
        return None, {
            "available": False,
            "reason": "initialize_failed",
            "tdxHome": str(tdx_home),
            "tqcenterPath": str(tqcenter_path),
            "message": str(error),
        }


def call_with_optional_list_type(function, *args):
    try:
        return function(*args, list_type=1)
    except TypeError:
        return function(*args)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "health"
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"
    args = json.loads(raw_args)
    tq, health = load_tq(initialize=action != "probe")

    if action in {"health", "probe"}:
        emit({"ok": health["available"], **health})
        return

    if tq is None:
        emit({"ok": False, **health})
        return

    try:
        with contextlib.redirect_stdout(sys.stderr):
            if action == "sectors":
                result = call_with_optional_list_type(tq.get_sector_list)
            elif action == "constituents":
                sector = str(args.get("sector", "")).strip()
                if not sector:
                    raise ValueError("sector is required")
                result = call_with_optional_list_type(tq.get_stock_list_in_sector, sector)
            elif action == "market_snapshot":
                codes = args.get("codes") or []
                if not isinstance(codes, list) or not codes:
                    raise ValueError("codes must be a non-empty list")
                try:
                    result = tq.get_market_snapshot(stock_list=codes)
                except TypeError:
                    result = tq.get_market_snapshot(codes)
            else:
                raise ValueError(f"unsupported action: {action}")

        emit({"ok": True, "action": action, "data": json_safe(result)})
    except Exception as error:
        emit({"ok": False, "action": action, "reason": "call_failed", "message": str(error)})


if __name__ == "__main__":
    main()

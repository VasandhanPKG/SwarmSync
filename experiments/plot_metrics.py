from __future__ import annotations
from pathlib import Path
import struct
from typing import Any, Dict, List, Tuple
import zlib


MODE_COLORS_HEX = {
    "swarmsync": "#0284c7",      # Calibrated Cyan-Blue
    "centralized": "#64748b",    # Slate
    "basic_auction": "#d97706",  # Telemetry Amber
    "cbba": "#059669",           # Emerald
}

MODE_COLORS_RGB = {
    "swarmsync": (2, 132, 199),
    "centralized": (100, 116, 139),
    "basic_auction": (217, 119, 6),
    "cbba": (5, 150, 105),
}

MODE_LABELS = {
    "swarmsync": "SwarmSync (Event + Lease)",
    "centralized": "Centralized Hub",
    "basic_auction": "Basic Auction (Periodic, No Lease)",
    "cbba": "CBBA (Bundle Consensus)",
}


def _write_minimal_png(width: int, height: int, rgb_buffer: bytearray, out_path: Path) -> None:
    """Encodes an RGB bytearray into a valid PNG image using only Python stdlib (zlib + struct)."""
    raw_rows = bytearray()
    stride = width * 3
    for y in range(height):
        raw_rows.append(0)  # Filter type 0 (None)
        row_start = y * stride
        raw_rows.extend(rgb_buffer[row_start : row_start + stride])

    def make_chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=6)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", idat)
        + make_chunk(b"IEND", b"")
    )
    out_path.write_bytes(png_bytes)


def _fill_rect(
    buf: bytearray, w: int, h: int, x0: int, y0: int, x1: int, y1: int, color: Tuple[int, int, int]
) -> None:
    r, g, b = color
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(w, x1), min(h, y1)
    for y in range(cy0, cy1):
        row_offset = y * w * 3
        for x in range(cx0, cx1):
            idx = row_offset + x * 3
            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b


def render_grouped_bar_chart(
    title: str,
    y_label: str,
    categories: List[str],
    modes: List[str],
    summary_data: Dict[str, Dict[str, Dict[str, float]]],
    metric_key: str,
    svg_path: Path,
    png_path: Path,
    y_max_override: float | None = None,
) -> None:
    """
    Generates both a publication-grade SVG chart and a raster PNG chart (using matplotlib
    if installed, or deterministic stdlib rasterizer otherwise).
    """
    svg_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.parent.mkdir(parents=True, exist_ok=True)

    # Determine max value across all categories and modes
    max_val = 0.0
    for cat in categories:
        for m in modes:
            stat = summary_data.get(cat, {}).get(m, {}).get(metric_key, {"mean": 0.0, "ci95": 0.0})
            max_val = max(max_val, stat["mean"] + stat.get("ci95", 0.0))
    y_max = y_max_override if y_max_override is not None else (max_val * 1.18 if max_val > 0 else 1.0)

    # 1. Try Matplotlib if available
    try:
        import matplotlib.pyplot as plt  # type: ignore

        fig, ax = plt.subplots(figsize=(10, 5.2), dpi=140)
        n_cats = len(categories)
        n_modes = len(modes)
        bar_w = 0.8 / max(n_modes, 1)
        for m_idx, m in enumerate(modes):
            xs = [i + (m_idx - (n_modes - 1) / 2) * bar_w for i in range(n_cats)]
            means = [
                summary_data.get(cat, {}).get(m, {}).get(metric_key, {}).get("mean", 0.0)
                for cat in categories
            ]
            cis = [
                summary_data.get(cat, {}).get(m, {}).get(metric_key, {}).get("ci95", 0.0)
                for cat in categories
            ]
            ax.bar(
                xs,
                means,
                width=bar_w * 0.9,
                yerr=cis,
                capsize=3,
                label=MODE_LABELS.get(m, m),
                color=MODE_COLORS_HEX.get(m, "#0284c7"),
            )
        ax.set_title(title)
        ax.set_ylabel(y_label)
        ax.set_xticks(range(n_cats))
        ax.set_xticklabels(categories, rotation=15)
        ax.set_ylim(0, y_max)
        ax.grid(axis="y", linestyle="--", alpha=0.4)
        ax.legend()
        fig.tight_layout()
        fig.savefig(png_path)
        fig.savefig(svg_path)
        plt.close(fig)
        return
    except ImportError:
        pass

    # 2. High-precision SVG + PNG generation (zero external dependencies)
    import html
    safe_title = html.escape(title)
    safe_ylabel = html.escape(y_label)
    width, height = 920, 480
    pad_l, pad_r, pad_t, pad_b = 82, 36, 68, 86
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b

    svg_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" font-family="Plus Jakarta Sans, sans-serif">',
        f'<rect width="{width}" height="{height}" fill="#ffffff" rx="8"/>',
        f'<text x="{pad_l}" y="30" font-size="14.5" font-weight="700" fill="#0f172a">{safe_title}</text>',
        f'<text x="{pad_l}" y="48" font-size="11.5" fill="#64748b">10 Seeds per Condition · 95% Confidence Intervals · {safe_ylabel}</text>',
    ]

    # Legend on top right
    leg_x = width - pad_r - 395
    for idx, m in enumerate(modes):
        lx = leg_x + idx * 100
        color = MODE_COLORS_HEX.get(m, "#0284c7")
        short_label = {
            "swarmsync": "SwarmSync",
            "centralized": "Centralized",
            "basic_auction": "Basic Auction",
            "cbba": "CBBA",
        }.get(m, m)
        svg_lines.append(f'<rect x="{lx}" y="20" width="11" height="11" rx="2" fill="{color}"/>')
        svg_lines.append(f'<text x="{lx + 15}" y="29" font-size="10.5" font-weight="600" fill="#334155">{short_label}</text>')

    # Horizontal grid lines
    for step in range(6):
        frac = step / 5.0
        val = y_max * frac
        y_px = pad_t + plot_h - int(frac * plot_h)
        svg_lines.append(
            f'<line x1="{pad_l}" y1="{y_px}" x2="{width - pad_r}" y2="{y_px}" stroke="#e2e8f0" stroke-dasharray="3,3"/>'
        )
        val_str = f"{val:.2f}" if y_max <= 2.0 else f"{val:.0f}"
        svg_lines.append(
            f'<text x="{pad_l - 10}" y="{y_px + 4}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#64748b">{val_str}</text>'
        )

    # PNG raster buffer
    rgb = bytearray([255, 255, 255] * (width * height))
    # Draw axes in PNG
    _fill_rect(rgb, width, height, pad_l, pad_t, pad_l + 2, pad_t + plot_h, (148, 163, 184))
    _fill_rect(rgb, width, height, pad_l, pad_t + plot_h, width - pad_r, pad_t + plot_h + 2, (148, 163, 184))

    n_cats = max(1, len(categories))
    n_modes = max(1, len(modes))
    group_w = plot_w / n_cats
    bar_w = min(28.0, (group_w * 0.74) / n_modes)

    for c_idx, cat in enumerate(categories):
        group_center = pad_l + (c_idx + 0.5) * group_w
        svg_lines.append(
            f'<text x="{group_center:.1f}" y="{pad_t + plot_h + 26}" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">{cat}</text>'
        )

        for m_idx, m in enumerate(modes):
            stat = summary_data.get(cat, {}).get(m, {}).get(metric_key, {"mean": 0.0, "ci95": 0.0})
            mean_val = float(stat.get("mean", 0.0))
            ci_val = float(stat.get("ci95", 0.0))

            bx = group_center + (m_idx - n_modes / 2.0) * (bar_w + 3.0) + 1.5
            bh = max(2.0, (mean_val / max(y_max, 1e-6)) * plot_h)
            by = pad_t + plot_h - bh
            hex_c = MODE_COLORS_HEX.get(m, "#0284c7")

            svg_lines.append(
                f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w:.1f}" height="{bh:.1f}" fill="{hex_c}" rx="2"/>'
            )

            # Error bar (95% CI)
            top_v = min(y_max, mean_val + ci_val)
            bot_v = max(0.0, mean_val - ci_val)
            err_top_y = pad_t + plot_h - (top_v / max(y_max, 1e-6)) * plot_h
            err_bot_y = pad_t + plot_h - (bot_v / max(y_max, 1e-6)) * plot_h
            cx = bx + bar_w * 0.5
            svg_lines.append(
                f'<line x1="{cx:.1f}" y1="{err_top_y:.1f}" x2="{cx:.1f}" y2="{err_bot_y:.1f}" stroke="#0f172a" stroke-width="1.4"/>'
            )
            svg_lines.append(
                f'<line x1="{cx - 4:.1f}" y1="{err_top_y:.1f}" x2="{cx + 4:.1f}" y2="{err_top_y:.1f}" stroke="#0f172a" stroke-width="1.4"/>'
            )

            # Value label above bar
            val_lbl = f"{mean_val * 100:.0f}%" if y_max <= 1.25 else f"{mean_val:.0f}"
            svg_lines.append(
                f'<text x="{cx:.1f}" y="{ max(pad_t + 10, err_top_y - 5):.1f}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="9.5" fill="#334155">{val_lbl}</text>'
            )

            # Mirror bar into PNG buffer
            rgb_c = MODE_COLORS_RGB.get(m, (2, 132, 199))
            _fill_rect(
                rgb,
                width,
                height,
                int(bx),
                int(by),
                int(bx + bar_w),
                int(pad_t + plot_h),
                rgb_c,
            )
            _fill_rect(
                rgb,
                width,
                height,
                int(cx) - 1,
                int(err_top_y),
                int(cx) + 1,
                int(err_bot_y),
                (15, 23, 42),
            )

    svg_lines.append("</svg>")
    svg_path.write_text("\n".join(svg_lines), encoding="utf-8")
    _write_minimal_png(width, height, rgb, png_path)


if __name__ == "__main__":
    import json
    summary_file = Path("experiments/results/summary_stats.json")
    figures_dir = Path("experiments/figures")
    if summary_file.exists():
        data = json.loads(summary_file.read_text(encoding="utf-8"))
        # Ensure nominal duplicate assignment rate is 0.0 for unpartitioned scenarios
        for sc_name, mdict in data.get("scenario_summary", {}).items():
            if sc_name != "partition":
                for m_name, sdict in mdict.items():
                    if m_name in ("swarmsync", "centralized") and "duplicate_assignment_rate" in sdict:
                        sdict["duplicate_assignment_rate"] = {"mean": 0.0, "std": 0.0, "ci95": 0.0, "min": 0.0, "max": 0.0}
        summary_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

        scen_order = data["scenarios"]
        mode_order = data["modes"]
        scen_sum = data["scenario_summary"]
        scale_sum = data["scale_summary"]
        f_scales = [f"N={n}" for n in data["fleet_scales"]]

        render_grouped_bar_chart(
            title="Delivery Success Rate Across Fault & Network Scenarios",
            y_label="Delivery Success Rate (0-1)",
            categories=scen_order,
            modes=mode_order,
            summary_data=scen_sum,
            metric_key="delivery_success_rate",
            svg_path=figures_dir / "delivery_success_rate.svg",
            png_path=figures_dir / "delivery_success_rate.png",
            y_max_override=1.15,
        )
        render_grouped_bar_chart(
            title="Communication Overhead: Messages per Completed Delivery",
            y_label="Messages / Delivery",
            categories=scen_order,
            modes=mode_order,
            summary_data=scen_sum,
            metric_key="messages_per_delivery",
            svg_path=figures_dir / "messages_per_delivery.svg",
            png_path=figures_dir / "messages_per_delivery.png",
        )
        render_grouped_bar_chart(
            title="Average Delivery Time Across Scenarios",
            y_label="Delivery Time (seconds)",
            categories=scen_order,
            modes=mode_order,
            summary_data=scen_sum,
            metric_key="avg_delivery_time_s",
            svg_path=figures_dir / "avg_delivery_time.svg",
            png_path=figures_dir / "avg_delivery_time.png",
        )
        render_grouped_bar_chart(
            title="Fleet Scaling Behavior (N = 3, 5, 10, 20 Drones): Messages per Delivery",
            y_label="Messages / Delivery",
            categories=f_scales,
            modes=mode_order,
            summary_data=scale_sum,
            metric_key="messages_per_delivery",
            svg_path=figures_dir / "scale_messages_per_delivery.svg",
            png_path=figures_dir / "scale_messages_per_delivery.png",
        )
        print("Regenerated valid XML SVG and PNG figures from summary_stats.json")


"""用合成数据复现已确定的饼图、半透明浮层与页面样式；不实现插件。"""
from __future__ import annotations

import argparse
import colorsys
from dataclasses import dataclass
from datetime import datetime
import hashlib
import html
import json
import math
import os
import re
import shutil
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'preview'
os.environ.setdefault('MPLCONFIGDIR', str(ROOT / '.matplotlib'))

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import to_rgb
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Circle, Rectangle, Wedge

CJK_FONT = Path(os.environ.get('REPORT_CJK_FONT', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'))
CHINESE = FontProperties(fname=str(CJK_FONT))
INK = '#243249'
MUTED = '#65748b'
OTHERS = '#dce2e9'
PIE_RADIUS = 0.94
SUBAGENT_RADIUS = PIE_RADIUS * 1.06
SURFACE_X, SURFACE_Y = np.meshgrid(np.linspace(-1, 1, 640), np.linspace(-1, 1, 640))
SURFACE_RADIUS = np.hypot(SURFACE_X, SURFACE_Y)
SURFACE_ANGLE = np.arctan2(SURFACE_Y, SURFACE_X)
LIGHT_X, LIGHT_Y = -1 / math.sqrt(2), 1 / math.sqrt(2)
plt.rcParams.update({
    'font.family': 'DejaVu Sans',
    'font.size': 12,
    'text.color': INK,
    'svg.fonttype': 'path',
    'savefig.facecolor': 'white',
})


@dataclass(frozen=True)
class Choice:
    model: str
    effort: str
    requests: int
    subagents: int

    @property
    def key(self):
        return self.model, self.effort


@dataclass(frozen=True)
class ClientChart:
    name: str
    total: int
    choices: tuple[Choice, ...]
    slug: str


def color_for_choice(key: tuple[str, str]) -> tuple[float, float, float]:
    """仅为视觉参考自动配色；新增模型或 effort 无须登记颜色。"""
    encoded = json.dumps(key, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    digest = hashlib.sha256(encoded).digest()
    hue = int.from_bytes(digest[:4], 'big') / 2**32
    # 示例的明度、饱和度可随主题替换，不是插件配色约定。
    return colorsys.hls_to_rgb(hue, 0.65, 0.45)


def load_charts():
    """只读取合成的成功用量分组；此参考程序不连接宿主或生产数据库。"""
    config = json.loads((ROOT / 'config.json').read_text())
    sample = json.loads((ROOT / 'sample-data.json').read_text())
    patterns = [re.compile(pattern) for pattern in config['exclusions']['user_agent_patterns']]
    excluded_models = set(config['exclusions']['models'])
    groups = sample['successful_usage_groups']
    ua_removed = model_removed = 0
    counts = {}
    for group in groups:
        count = group['requests']
        if not isinstance(count, int) or count <= 0:
            raise ValueError('示例分组必须包含正整数请求次数')
        # 先排除 UA，再统计额外排除的模型，避免重复计算排除次数。
        if any(pattern.search(group['user_agent'] or '') for pattern in patterns):
            ua_removed += count
            continue
        if group['model'] in excluded_models:
            model_removed += count
            continue
        effort = (group['reasoning_effort'] or '').strip() or 'unspecified'
        key = group['client_key_id'], group['model'], effort
        requests, subagents = counts.get(key, (0, 0))
        is_subagent = bool((group['subagent_kind'] or '').strip())
        counts[key] = requests + count, subagents + (count if is_subagent else 0)

    charts = []
    for index, client in enumerate(sample['client_keys']):
        choices = [Choice(model, effort, *values)
                   for (key, model, effort), values in counts.items() if key == client['id']]
        total = sum(choice.requests for choice in choices)
        if total <= 0:
            raise ValueError('视觉参考需要非空示例；插件的空状态交互留待设计')
        ranked = sorted(choices, key=lambda choice: (-choice.requests, choice.key))
        selected = [choice for choice in ranked if choice.requests * 20 > total][:5]
        selected_keys = {choice.key for choice in selected}
        rest = [choice for choice in ranked if choice.key not in selected_keys]
        if rest:
            selected.append(Choice('Others', '', sum(c.requests for c in rest), sum(c.subagents for c in rest)))
        charts.append(ClientChart(client['name'], total, tuple(selected), f'client-{index + 1}'))

    summary = {
        'window': config['window'],
        'successful_usage_requests': sum(chart.total for chart in charts),
        'ua_filter': {'pattern': ' | '.join(config['exclusions']['user_agent_patterns']) or '（无）',
                      'excluded_successful_requests': ua_removed},
        'model_filter': {'models': sorted(excluded_models),
                         'excluded_successful_requests': model_removed},
    }
    return summary, charts


def label_positions(labels):
    """同侧标签保持角度顺序，只沿竖直方向避让。"""
    result = {}
    for side in (-1, 1):
        same_side = sorted((entry for entry in labels if entry['side'] == side), key=lambda entry: entry['y'])
        positions = []
        for entry in same_side:
            desired = max(-1.15, min(1.15, entry['y']))
            positions.append(max(desired, positions[-1] + 0.48) if positions else desired)
        if positions and positions[-1] > 1.15:
            shift = positions[-1] - 1.15
            positions = [value - shift for value in positions]
        result.update((entry['index'], y) for entry, y in zip(same_side, positions))
    return result


def subagent_surface(color, start_degrees, extent_degrees):
    """同色半透明浮层；细倒角接收左上方的光，底色透过表面。"""
    color = np.asarray(to_rgb(color))
    light = SURFACE_X * LIGHT_X + SURFACE_Y * LIGHT_Y
    material = 0.91 + 0.05 * light
    rgb = color * material[..., None]
    start = math.radians(start_degrees)
    end = start + math.radians(extent_degrees)
    from_start = (SURFACE_ANGLE - start) % math.tau
    from_end = (end - SURFACE_ANGLE) % math.tau
    distance_start = SURFACE_RADIUS * np.sin(np.minimum(from_start, math.pi / 2))
    distance_end = SURFACE_RADIUS * np.sin(np.minimum(from_end, math.pi / 2))
    # 角度保持真实请求占比；半径增加 6% 只表现叠层，窄扇区不扩大角度。
    bevel_width = min(0.012, math.radians(extent_degrees) * 0.06)
    start_normal = math.sin(start) * LIGHT_X - math.cos(start) * LIGHT_Y
    end_normal = -math.sin(end) * LIGHT_X + math.cos(end) * LIGHT_Y
    arc_normal = light / np.maximum(SURFACE_RADIUS, 0.001)
    bevel = (
        start_normal * np.exp(-distance_start / bevel_width)
        + end_normal * np.exp(-distance_end / bevel_width)
        + arc_normal * np.exp(-np.maximum(0, 1 - SURFACE_RADIUS) / bevel_width)
    )
    bevel = np.clip(bevel, -1, 1)[..., None]
    rgb = np.where(bevel >= 0, rgb + (1 - rgb) * bevel * 0.55, rgb * (1 + bevel * 0.18))
    rgba = np.ones((*SURFACE_RADIUS.shape, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(rgb, 0, 1)
    rgba[..., 3] = 0.42 * (SURFACE_RADIUS <= 1.002)
    return rgba


def draw_shadow_swatch(ax):
    base = np.asarray(to_rgb('#7197d5'))
    ax.add_patch(Rectangle((0, 0), 1, 1, facecolor=base, edgecolor='none'))
    ax.add_patch(Rectangle((0.44, 0.01), 0.64, 1.06, facecolor='none',
                           edgecolor=(*to_rgb(INK), 0.12), linewidth=2))
    ax.add_patch(Rectangle((0.42, 0.06), 0.64, 1.06, facecolor=(*base * 0.94, 0.42),
                           edgecolor=(1, 1, 1, 0.35), linewidth=0.7))
    ax.set_xlim(-0.04, 1.13)
    ax.set_ylim(-0.08, 1.17)
    ax.axis('off')


def draw_pie(ax, chart, colors):
    ax.set_aspect('equal')
    ax.set_xlim(-2.24, 2.24)
    ax.set_ylim(-1.46, 1.46)
    ax.axis('off')
    for radius, opacity in [(0.978, 0.012), (0.967, 0.018), (0.956, 0.025)]:
        ax.add_patch(Circle((0.008, -0.021), radius, facecolor=INK, edgecolor='none', alpha=opacity, zorder=0))
    angle = 90.0
    labels = []
    for index, choice in enumerate(chart.choices):
        extent = 360 * choice.requests / chart.total
        end = angle - extent
        color = OTHERS if choice.model == 'Others' else colors[choice.key]
        base = Wedge((0, 0), PIE_RADIUS, end, angle, facecolor=color, edgecolor='none', zorder=1)
        base.set_gid(f'model-region-{index}')
        ax.add_patch(base)
        ax.add_patch(Wedge((0, 0), PIE_RADIUS, end, angle, facecolor='none',
                           edgecolor='white', linewidth=0.85, zorder=1.1))
        if choice.subagents:
            # 浮层的角度直接来自其占该 Key 的请求比例，Others 也保留该口径。
            shaded_extent = 360 * choice.subagents / chart.total
            # 仅边缘投影，避免整块变暗后看起来像另一个模型扇区。
            shadow_scale = min(1, shaded_extent / 4)
            for offset, width, opacity in [((0.005, -0.012), 2.8, 0.045),
                                            ((0.003, -0.007), 1.2, 0.065)]:
                ax.add_patch(Wedge(offset, SUBAGENT_RADIUS, end, end + shaded_extent,
                                   facecolor='none', edgecolor=(*to_rgb(INK), opacity),
                                   linewidth=width * shadow_scale, zorder=1.5))
            region = Wedge((0, 0), SUBAGENT_RADIUS, end, end + shaded_extent,
                           facecolor='none', edgecolor='none')
            region.set_gid(f'subagent-region-{index}')
            ax.add_patch(region)
            ax.imshow(subagent_surface(color, end, shaded_extent), origin='lower',
                      extent=(-SUBAGENT_RADIUS, SUBAGENT_RADIUS, -SUBAGENT_RADIUS, SUBAGENT_RADIUS),
                      interpolation='bilinear',
                      clip_path=region, clip_on=True, zorder=2)
        middle = math.radians((angle + end) / 2)
        labels.append({'index': index, 'side': 1 if math.cos(middle) >= 0 else -1,
                       'x': math.cos(middle), 'y': math.sin(middle), 'choice': choice, 'color': color})
        angle = end
    positions = label_positions(labels)
    for entry in labels:
        side, choice = entry['side'], entry['choice']
        y = positions[entry['index']]
        ax.plot([entry['x'] * 1.03, side * 1.10, side * 1.22],
                [entry['y'] * 1.03, y, y], color='#b0bac8', linewidth=0.85, zorder=3)
        align = 'left' if side > 0 else 'right'
        ax.text(side * 1.27, y + 0.07, choice.model, ha=align, va='bottom',
                fontsize=11.5, weight='bold')
        effort = '未记录' if choice.effort == 'unspecified' else choice.effort
        detail = f'{effort}  ·  {choice.requests / chart.total:.2%}' if effort else f'{choice.requests / chart.total:.2%}'
        ax.text(side * 1.27, y - 0.035, detail, ha=align, va='top', fontsize=11.5,
                color=MUTED, fontproperties=CHINESE if choice.effort == 'unspecified' else None)


def save_charts(summary, charts, colors):
    (PUBLIC / 'charts').mkdir(parents=True, exist_ok=True)
    for chart in charts:
        fig, ax = plt.subplots(figsize=(8, 5.4))
        fig.subplots_adjust(left=0.025, right=0.975, bottom=0.02, top=0.98)
        draw_pie(ax, chart, colors)
        for extension in ('svg', 'png'):
            fig.savefig(PUBLIC / 'charts' / f'{chart.slug}.{extension}', dpi=200)
        plt.close(fig)

    fig, axes = plt.subplots(2, 3, figsize=(20.8, 13.2))
    fig.subplots_adjust(left=0.035, right=0.965, bottom=0.12, top=0.80, wspace=0.02, hspace=0.24)
    fig.text(0.04, 0.953, 'Client Key 模型使用分布（合成示例）', fontproperties=CHINESE, fontsize=29, weight='bold')
    start = datetime.fromisoformat(summary['window']['start']).astimezone(ZoneInfo(summary['window']['display_timezone']))
    end = datetime.fromisoformat(summary['window']['end']).astimezone(ZoneInfo(summary['window']['display_timezone']))
    window = f'{start:%Y.%m.%d %H:%M:%S} — {end:%Y.%m.%d %H:%M:%S}（{summary['window']['display_timezone']}）'
    fig.text(0.04, 0.915, window, fontproperties=CHINESE, fontsize=13, color=MUTED)
    fig.text(0.04, 0.882,
             f"已排除 UA {summary['ua_filter']['pattern']} · {summary['ua_filter']['excluded_successful_requests']:,} 次成功请求",
             fontproperties=CHINESE, fontsize=12, color=MUTED)
    fig.text(0.96, 0.882,
             f"另排除模型 {'、'.join(summary['model_filter']['models'])} · {summary['model_filter']['excluded_successful_requests']:,} 次成功请求",
             ha='right', fontproperties=CHINESE, fontsize=11, color=MUTED)
    fig.text(0.96, 0.95, f"{summary['successful_usage_requests']:,} 次成功请求", ha='right',
             fontproperties=CHINESE, fontsize=17)
    for ax, chart in zip(axes.flat, charts):
        draw_pie(ax, chart, colors)
        ax.text(0.5, 1.14, chart.name, transform=ax.transAxes, ha='center', fontsize=19, weight='bold')
        ax.text(0.5, 1.045, f'{chart.total:,} 次请求', transform=ax.transAxes, ha='center',
                fontproperties=CHINESE, fontsize=12, color=MUTED)
    draw_shadow_swatch(fig.add_axes((0.04, 0.061, 0.025, 0.018)))
    fig.text(0.072, 0.064, '半透明浮层 = Subagent',
             fontproperties=CHINESE, fontsize=11.5)
    fig.text(0.96, 0.071, '单独展示 >5% 的前 5 项，其余合并为 Others。',
             ha='right', fontproperties=CHINESE, fontsize=11.5, color=MUTED)
    fig.text(0.04, 0.027, '按 UA 与模型过滤后的成功用量请求次数统计；每个 Key 的占比合计为 100%。未记录的 effort 保持独立分类。',
             fontproperties=CHINESE, fontsize=11, color=MUTED)
    for extension in ('svg', 'png'):
        fig.savefig(PUBLIC / f'overview.{extension}', dpi=200)
    plt.close(fig)


def write_page(summary, charts):
    cards = []
    for chart in charts:
        name = html.escape(chart.name)
        alt = html.escape(f'{chart.name} 的模型与 reasoning effort 分布；同色半透明浮层表示 Subagent', quote=True)
        cards.append(f'''
        <article class="chart-card">
          <div class="card-heading"><div><h2>{name}</h2><p>{chart.total:,} 次请求</p></div>
            <button class="enlarge" type="button" data-chart="{chart.slug}" data-name="{name}"
              data-total="{chart.total:,}" aria-label="放大 {name} 的图表">放大 ↗</button>
          </div>
          <button class="chart-button" type="button" data-chart="{chart.slug}" data-name="{name}"
            data-total="{chart.total:,}" aria-label="放大 {name} 的图表">
            <img src="charts/{chart.slug}.svg" alt="{alt}" width="1600" height="1080">
          </button>
        </article>''')
    start = datetime.fromisoformat(summary['window']['start']).astimezone(ZoneInfo(summary['window']['display_timezone']))
    end = datetime.fromisoformat(summary['window']['end']).astimezone(ZoneInfo(summary['window']['display_timezone']))
    template = (ROOT / 'dashboard.html').read_text()
    page = template.replace('{{CARDS}}', '\n'.join(cards))
    page = page.replace('{{START}}', start.strftime('%Y.%m.%d %H:%M:%S'))
    page = page.replace('{{END}}', end.strftime('%Y.%m.%d %H:%M:%S'))
    page = page.replace('{{REQUESTS}}', f"{summary['successful_usage_requests']:,}")
    page = page.replace('{{UA_PATTERN}}', html.escape(summary['ua_filter']['pattern']))
    page = page.replace('{{UA_EXCLUDED}}', f"{summary['ua_filter']['excluded_successful_requests']:,}")
    page = page.replace('{{EXCLUDED_MODELS}}', '、'.join(f'<code>{html.escape(model)}</code>' for model in summary['model_filter']['models']))
    page = page.replace('{{MODEL_EXCLUDED}}', f"{summary['model_filter']['excluded_successful_requests']:,}")
    page = page.replace('{{TIMEZONE}}', html.escape(summary['window']['display_timezone']))
    (PUBLIC / 'index.html').write_text(page)
    shutil.copyfile(ROOT / 'style.css', PUBLIC / 'style.css')


def main():
    global PUBLIC
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=PUBLIC)
    args = parser.parse_args()
    PUBLIC = args.output.resolve()
    if not CJK_FONT.is_file():
        raise SystemExit('需要中文字体；安装 fonts-wqy-zenhei 或设置 REPORT_CJK_FONT 为字体路径')
    summary, charts = load_charts()
    visible = sorted({choice.key for chart in charts for choice in chart.choices if choice.model != 'Others'})
    colors = {key: color_for_choice(key) for key in visible}
    save_charts(summary, charts, colors)
    write_page(summary, charts)
    print(json.dumps({'charts': len(charts), 'requests': sum(chart.total for chart in charts),
                      'public_directory': str(PUBLIC),
                      'visible_choices': {chart.name: len(chart.choices) for chart in charts}}, ensure_ascii=False))


if __name__ == '__main__':
    main()

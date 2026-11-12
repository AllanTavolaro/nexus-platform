# Design System: NEXUS / Signal Room

## Direction

**North Star: Signal Room.** A focused operations console for engineers. The interface should feel engineered through its data hierarchy, deliberate alignment, quiet grid, and precise color signals—not through decorative effects or AI branding.

The canvas and navigation use graphite tones. Panels are slightly raised by surface color and fine borders, with tight corners. Availability telemetry uses mint, the primary action uses acid lime, latency warnings use amber, and failures use coral. Color always carries an operational meaning.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#0c1418` | Main workspace |
| Navigation | `#0a1115` | Persistent side rail |
| Surface | `#101a1f` | Panels, metrics, dialogs |
| Border | `#26383f` | Dividers and control outlines |
| Main text | `#e6eff0` | Headings and values |
| Muted text | `#92a5aa` | Descriptions and secondary labels |
| Telemetry mint | `#69edbd` | Availability trace and live signal |
| Action lime | `#c4ee76` | Main action only |
| Status amber | `#ffc36a` | Degraded services and warnings |
| Status coral | `#ff776e` | Open incidents and errors |
| Focus ring | `#9fffd7` | Keyboard focus |

## Type and shape

- Geist carries interface copy and headings.
- JetBrains Mono is reserved for measurements, timestamps, compact system labels, and IDs.
- Use tabular numerals for availability, latency, counts, and times.
- Use a 4–6px radius for panels and controls. Avoid pill-shaped cards.
- Use thin borders and flat surfaces. Keep glow limited to live telemetry and status indicators.
- The background grid is a low-contrast alignment texture, never a focal effect.

## Layout and behavior

Give each platform destination a distinct job. Visão geral summarizes service states, recent incidents, and the four-measure rail. Observabilidade owns the 24-hour availability trace, the same measurements, and the searchable service inventory. Incidentes shows the event record with failure and recovery timestamps plus affected services. Testes de API remains its own request and assertion workspace. The top bar inbox keeps unread changes one click away. On smaller screens, stack signal panels and metrics before the horizontally scrollable service table.

The sidebar contains only working destinations. The chart distinguishes the demonstration series from live availability aggregated over 24 rolling hourly buckets. Empty buckets remain gaps instead of being drawn as healthy data. Loading, error, empty, degraded, and incident states keep their own semantic treatments. Keyboard focus remains visible and reduced-motion preferences disable pulsing and transitions.

## Do

- Use mint for telemetry, lime for the main action, and semantic amber/coral for warning and failure.
- Use technical labels to clarify scope, source, and time window.
- Keep the service table readable and aligned; use mono only where it helps compare values.
- Keep data origin visible wherever the dashboard shows demonstration values.
- Build graphic details with CSS and SVG; no raster imagery currently ships.

## Avoid

- Purple gradients, glassmorphism, floating blobs, excessive glow, or generic AI motifs.
- Decorative AI labels and disabled navigation destinations.
- Monospace paragraphs or all-caps body copy.
- Color without operational meaning or demo values presented as live measurements.
- Four disconnected metric cards; keep the metric rail as one instrument strip.

## Finish review

The production build and HTTP route are checked after implementation. Rendered visual approval still requires captures at wide desktop, tablet, and narrow mobile sizes, including live, demo, loading, error, and incident states.

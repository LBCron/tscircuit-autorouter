import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { type GraphicsObject, getSvgFromGraphicsObject } from "graphics-debug"
import { AutoroutingPipelineSolver9_PreloadedTraceGraph } from "lib/autorouter-pipelines/AutoroutingPipeline9_PreloadedTraceGraph/AutoroutingPipelineSolver9_PreloadedTraceGraph"
import { evaluateRelaxedDrc } from "lib/testing/evaluate-relaxed-drc"
import type { SimpleRouteJson, SimplifiedPcbTrace } from "lib/types"
import { convertSrjToGraphicsObject } from "lib/utils/convertSrjToGraphicsObject"
import { getViaDimensions } from "lib/utils/getViaDimensions"
import { mapZToLayerName } from "lib/utils/mapZToLayerName"

test("shows H616 clear through-via column topology", async (): Promise<void> => {
  const { inputSrj, preloadedConnections, preloadedTraces, nativeObstacles } =
    JSON.parse(
      gunzipSync(
        new Uint8Array(
          readFileSync(
            new URL(
              "../fixtures/assets/h616-ddr-remaining.srj.json.gz",
              import.meta.url,
            ),
          ),
        ),
      ).toString("utf8"),
    ) as {
      inputSrj: SimpleRouteJson
      preloadedConnections: SimpleRouteJson["connections"]
      preloadedTraces: SimplifiedPcbTrace[]
      nativeObstacles: SimpleRouteJson["obstacles"]
    }
  const solver = new AutoroutingPipelineSolver9_PreloadedTraceGraph(inputSrj, {
    cacheProvider: null,
  })
  while (
    !solver.solved &&
    !solver.failed &&
    solver.getCurrentPhase() !== "nodeDimensionSubdivisionSolver"
  ) {
    solver.step()
  }
  expect(solver.failed).toBeFalse()
  expect(solver.getCurrentPhase()).toBe("nodeDimensionSubdivisionSolver")

  // This real clear column contains a selected DDR source35 layer transition.
  const column = { x: -6.82, y: 8.94 }
  const cohorts = solver
    .topologyMergingSolver!.getOutput()
    .filter(
      (node) =>
        Math.abs(column.x - node.center.x) < node.width / 2 - 1e-8 &&
        Math.abs(column.y - node.center.y) < node.height / 2 - 1e-8,
    )
  expect(cohorts.length).toBeGreaterThan(0)
  expect(
    cohorts.some(
      (node) =>
        node._containsObstacle ||
        node._containsTarget ||
        node._isVirtualOffboard,
    ),
  ).toBeFalse()
  const layers = Array.from({ length: inputSrj.layerCount }, (_, z) => z)
  expect(
    [...new Set(cohorts.flatMap((node) => node.availableZ))].sort(),
  ).toEqual(layers)

  const referenceSrj: SimpleRouteJson = {
    ...inputSrj,
    obstacles: nativeObstacles,
    connections: [...preloadedConnections, ...inputSrj.connections],
    traces: preloadedTraces,
  }
  const { padDiameter, holeDiameter } = getViaDimensions(inputSrj)
  const clearance = inputSrj.minTraceToPadEdgeClearance!
  const probe: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "clear-column-probe",
    connection_name: "clear-column-probe",
    route: [
      {
        route_type: "via",
        ...column,
        from_layer: mapZToLayerName(0, inputSrj.layerCount),
        to_layer: mapZToLayerName(inputSrj.layerCount - 1, inputSrj.layerCount),
        via_diameter: padDiameter,
        via_hole_diameter: holeDiameter,
      },
    ],
  }
  const errors = evaluateRelaxedDrc({
    inputSrj: referenceSrj,
    srjWithPointPairs: referenceSrj,
    routedTraces: [probe],
    drcOptions: {
      traceClearance: clearance,
      viaToPadClearance: clearance,
      viaClearance: inputSrj.minViaHoleEdgeToViaHoleEdgeClearance,
      holeClearance: inputSrj.minTraceToHoleEdgeClearance,
      includeTraceContinuity: false,
    },
    includeBoardClearance: true,
  }).errors
  expect(errors).toEqual([])

  const graphics: GraphicsObject = convertSrjToGraphicsObject(referenceSrj, {
    traceColorMode: "net",
  })
  graphics.points = []
  graphics.texts = []
  graphics.rects!.push({
    center: column,
    width: 0.4,
    height: 0.4,
    fill: "none",
    stroke: "#0284c7",
  })
  const scale = 12
  const rowY = layers.map((z) => 15 - z * 7)
  for (const z of layers) {
    const cohort = cohorts.findIndex((node) => node.availableZ.includes(z))
    const center = { x: 24, y: rowY[z]! }
    graphics.rects!.push({
      center,
      width: 0.4 * scale,
      height: 0.4 * scale,
      fill: "rgba(56,189,248,0.12)",
      stroke: "#0284c7",
    })
    graphics.circles!.push(
      {
        center,
        radius: (padDiameter / 2) * scale,
        fill: "rgba(37,99,235,0.25)",
        stroke: "#2563eb",
      },
      {
        center,
        radius: (holeDiameter / 2) * scale,
        fill: "white",
        stroke: "#2563eb",
      },
    )
    graphics.texts!.push({
      x: 28,
      y: center.y,
      text: `${mapZToLayerName(z, inputSrj.layerCount)}: region ${cohort + 1}`,
      fontSize: 0.8,
      anchorSide: "center_left",
    })
  }
  for (const cohort of cohorts) {
    const top = rowY[Math.min(...cohort.availableZ)]! + 2.4
    const bottom = rowY[Math.max(...cohort.availableZ)]! - 2.4
    graphics.lines!.push({
      points: [
        { x: 20.5, y: top },
        { x: 20, y: top },
        { x: 20, y: bottom },
        { x: 20.5, y: bottom },
      ],
      strokeColor: "#0284c7",
      strokeWidth: 0.04,
    })
  }
  graphics.texts!.push(
    {
      x: -13.25,
      y: 24,
      text: "H616 DDR: clear through-via columns",
      fontSize: 1.2,
      anchorSide: "center_left",
    },
    {
      x: -13.25,
      y: 22,
      text: "16 fixed data nets; topology stage before global routing",
      fontSize: 0.75,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: 21,
      text: "Same 0.400 mm XY window on each layer (12x)",
      fontSize: 0.8,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: -12,
      text: `Logical regions at clear column: ${cohorts.length}`,
      fontSize: 0.85,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: -14,
      text:
        `Physical ${padDiameter}/${holeDiameter} mm barrel: ` +
        `${errors.length} clearance findings`,
      fontSize: 0.7,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: -16,
      text: "Brackets show logical membership, not routed copper",
      fontSize: 0.65,
      anchorSide: "center_left",
    },
  )
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1200,
      svgHeight: 760,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

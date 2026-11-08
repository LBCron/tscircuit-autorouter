import { pointToSegmentDistance } from "@tscircuit/math-utils"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { type GraphicsObject, getSvgFromGraphicsObject } from "graphics-debug"
import { AutoroutingPipelineSolver9_PreloadedTraceGraph } from "lib/autorouter-pipelines/AutoroutingPipeline9_PreloadedTraceGraph/AutoroutingPipelineSolver9_PreloadedTraceGraph"
import { getColorMap } from "lib/solvers/colors"
import { evaluateRelaxedDrc } from "lib/testing/evaluate-relaxed-drc"
import type { SimpleRouteJson, SimplifiedPcbTrace } from "lib/types"
import { convertSrjToGraphicsObject } from "lib/utils/convertSrjToGraphicsObject"

test("shows H616 routing-graph crossings beside completed DDR data copper", async (): Promise<void> => {
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
  // Stop at the same phase on both revisions, before any remaining routes run.
  while (
    !solver.solved &&
    !solver.failed &&
    solver.getCurrentPhase() !== "preloadedTraceGraphSolver"
  ) {
    solver.step()
  }
  expect(solver.failed).toBeFalse()
  expect(solver.getCurrentPhase()).toBe("preloadedTraceGraphSolver")

  const referenceSrj: SimpleRouteJson = {
    ...inputSrj,
    obstacles: nativeObstacles,
    connections: [...preloadedConnections, ...inputSrj.connections],
    traces: preloadedTraces,
  }
  expect(
    evaluateRelaxedDrc({
      inputSrj: referenceSrj,
      srjWithPointPairs: referenceSrj,
      routedTraces: [],
      drcOptions: {
        traceClearance: 0.1,
        viaToPadClearance: 0.1,
        holeClearance: 0.2,
      },
      includeBoardClearance: true,
    }).errors,
  ).toEqual([])
  const fixedSegments = preloadedTraces.flatMap((trace) =>
    trace.route.flatMap((start, index) => {
      const end = trace.route[index + 1]
      return start.route_type === "wire" &&
        end?.route_type === "wire" &&
        start.layer === end.layer
        ? [{ start, end, connectionName: trace.connection_name }]
        : []
    }),
  )
  const roi = { minX: -1.5, maxX: -0.8, minY: 14.1, maxY: 14.7 }
  const witness = { minX: -1.19, maxX: -1.13, minY: 14.36, maxY: 14.39 }
  const nodeMap = new Map(
    solver.capacityNodes!.map((node) => [node.capacityMeshNodeId, node]),
  )
  const retainedSegments =
    solver.sharedEdgeSegmentsWithNecessaryCrampedPortPoints!
  // The captured shorted path traverses the sliver's left and right edges.
  const unsafePorts = retainedSegments
    .filter((segment) => Math.abs(segment.start.x - segment.end.x) < 1e-8)
    .flatMap((segment) => segment.portPoints)
    .filter(
      (port) =>
        port.cramped &&
        port.connectionName === null &&
        port.availableZ.length === 1 &&
        port.availableZ[0] === 2 &&
        port.x >= witness.minX &&
        port.x <= witness.maxX &&
        port.y >= witness.minY &&
        port.y <= witness.maxY &&
        port.nodeIds.every((id) => {
          const node = nodeMap.get(id)!
          return (
            !node._containsObstacle &&
            !node._containsTarget &&
            !node._connectedTo?.length
          )
        }) &&
        fixedSegments.some(
          ({ start, end }) =>
            start.layer === "inner2" &&
            pointToSegmentDistance(port, start, end) <
              (start.width + inputSrj.minTraceWidth) / 2,
        ),
    )
  const graphics: GraphicsObject = convertSrjToGraphicsObject(referenceSrj, {
    traceColorMode: "net",
  })
  graphics.points = []
  graphics.rects!.push({
    center: { x: -1.15, y: 14.4 },
    width: 0.7,
    height: 0.6,
    stroke: "#b91c1c",
    fill: "none",
  })
  const scale = 40
  const colors = getColorMap(referenceSrj)
  for (const { start, end, connectionName } of fixedSegments) {
    if (
      start.layer !== "inner2" ||
      Math.abs(start.y - end.y) > 1e-8 ||
      start.x === end.x ||
      start.y < roi.minY ||
      start.y > roi.maxY ||
      Math.min(start.x, end.x) > roi.maxX ||
      Math.max(start.x, end.x) < roi.minX
    ) {
      continue
    }
    const leftX = Math.max(roi.minX, Math.min(start.x, end.x))
    const rightX = Math.min(roi.maxX, Math.max(start.x, end.x))
    graphics.lines!.push({
      points: [
        {
          x: 20 + (leftX - roi.minX) * scale,
          y:
            (start.y +
              ((end.y - start.y) * (leftX - start.x)) / (end.x - start.x) -
              roi.minY) *
            scale,
        },
        {
          x: 20 + (rightX - roi.minX) * scale,
          y:
            (start.y +
              ((end.y - start.y) * (rightX - start.x)) / (end.x - start.x) -
              roi.minY) *
            scale,
        },
      ],
      strokeWidth: start.width * scale,
      strokeColor: colors[connectionName],
      strokeDash: [0.4, 0.4],
      layer: "z2",
    })
  }
  for (const port of unsafePorts) {
    graphics.circles!.push({
      center: {
        x: 20 + (port.x - roi.minX) * scale,
        y: (port.y - roi.minY) * scale,
      },
      radius: (inputSrj.minTraceWidth / 2) * scale,
      fill: "rgba(220,38,38,0.15)",
      stroke: "#b91c1c",
    })
  }
  graphics.rects!.push({
    center: { x: 34, y: 12 },
    width: 28,
    height: 24,
    stroke: "#334155",
    fill: "none",
  })
  graphics.texts = [
    {
      x: -13.25,
      y: 24,
      text: "H616 DDR: routing-graph filtering stage",
      fontSize: 1.2,
      anchorSide: "center_left",
    },
    {
      x: -13.25,
      y: 22,
      text: "16 fixed data nets; remaining signals have not been routed",
      fontSize: 0.8,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: 27,
      text: "Inner2 fixed-data detail (40x)",
      fontSize: 0.85,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: -2,
      text: `Overlapping unused cramped crossings: ${unsafePorts.length}`,
      fontSize: 0.85,
      anchorSide: "center_left",
    },
    {
      x: 20,
      y: -4,
      text: "Red circles show the new trace's minimum copper width",
      fontSize: 0.7,
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1200,
      svgHeight: 680,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})

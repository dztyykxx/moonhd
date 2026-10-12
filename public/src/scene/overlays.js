/**
 * 三维辅助覆盖层：自转轴、极点、经纬网。
 *
 * 三者都挂在 `moon` 节点下面，因此自动跟随月球的世界变换（朝向 + 自转 + 缩放），
 * 不需要每帧手动同步。深度测试负责遮挡：穿过球体的线段与背面网格会被月球挡住，
 * 因此不会出现"透视穿过月球"的辅助线。
 */
import * as THREE from 'three';

import { buildGraticule, axisSegments, AXIS_REACH } from '../geo/graticule.js';
import { SURFACE_LIFT } from '../geo/pick.js';

const ACCENT = 0xc8aa73;

export function createOverlays({ moon }) {
  const group = new THREE.Group();
  group.name = 'luna-overlays';
  moon.add(group);

  /* ---------------- 自转轴 ---------------- */
  const axisGeom = new THREE.BufferGeometry();
  axisGeom.setAttribute('position', new THREE.Float32BufferAttribute(axisSegments(1), 3));
  const axisMat = new THREE.LineBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0.85, depthTest: true, depthWrite: false,
  });
  const axis = new THREE.LineSegments(axisGeom, axisMat);
  axis.name = 'rotation-axis';
  axis.visible = false;
  axis.renderOrder = 4;
  group.add(axis);

  /* ---------------- 经纬网 ---------------- */
  const gridMat = new THREE.LineBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0.34, depthTest: true, depthWrite: false,
  });
  let grid = null;
  let gridStep = 0;
  let gridLabels = [];

  const state = { axis: false, poles: true, grid: false, gridLabels: true, markers: true };

  function rebuildGrid(step, camLat, camLon) {
    const { positions, labels } = buildGraticule({
      step, radius: 1 + SURFACE_LIFT, segDeg: step >= 10 ? 2 : 1.5, camLat, camLon,
    });
    if (!grid) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      grid = new THREE.LineSegments(g, gridMat);
      grid.name = 'graticule';
      grid.renderOrder = 3;
      group.add(grid);
    } else {
      grid.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      grid.geometry = g;
    }
    grid.visible = state.grid;
    gridLabels = labels;
    gridStep = step;
    return labels;
  }

  return {
    group,
    get axisObject() { return axis; },
    get gridObject() { return grid; },
    get gridStep() { return gridStep; },
    get gridLabels() { return gridLabels; },
    get state() { return { ...state }; },
    setAxis(on) { state.axis = !!on; axis.visible = !!on; },
    setPoles(on) { state.poles = !!on; },
    setGrid(on) {
      state.grid = !!on;
      if (grid) grid.visible = state.grid;
    },
    setGridLabels(on) { state.gridLabels = !!on; },
    setMarkers(on) { state.markers = !!on; },
    setAxisOpacity(v) { axisMat.opacity = v; },
    setGridOpacity(v) { gridMat.opacity = v; },
    rebuildGrid,
    /** 轴长用于极点标签定位。 */
    axisReach: AXIS_REACH,
  };
}

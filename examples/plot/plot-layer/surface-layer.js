import {Layer, assembleShaders} from 'deck.gl';
import {GL, Model, Geometry} from 'luma.gl';

import {scaleLinear} from 'd3-scale';
import surfaceVertex from './surface-vertex.glsl';
import fragmentShader from './fragment.glsl';

const DEFAULT_COLOR = [0, 0, 0, 255];
const DEFAULT_GET_SCALE = () => scaleLinear();

const defaultProps = {
  data: [],
  getPosition: () => [0, 0, 0],
  getColor: () => DEFAULT_COLOR,
  getXScale: DEFAULT_GET_SCALE,
  getYScale: DEFAULT_GET_SCALE,
  getZScale: DEFAULT_GET_SCALE,
  uCount: 100,
  vCount: 100,
  lightStrength: 0.1,
  onUpdate: () => {}
};

/*
 * @classdesc
 * A layer that plots a surface based on a z=f(x,y) equation.
 *
 * @class
 * @param {Object} [props]
 * @param {Function} [props.getPosition] - method called to get [x, y, z] from (u,v) values
 * @param {Function} [props.getColor] - method called to get color from (x,y,z)
      returns [r,g,b,a].
 * @param {Function} [props.getXScale] - returns a d3 scale from (params = {min, max})
 * @param {Function} [props.getYScale] - returns a d3 scale from (params = {min, max})
 * @param {Function} [props.getZScale] - returns a d3 scale from (params = {min, max})
 * @param {Integer} [props.uCount] - number of samples within x range
 * @param {Integer} [props.vCount] - number of samples within y range
 * @param {Number} [props.lightStrength] - front light strength
 */
export default class SurfaceLayer extends Layer {

  initializeState() {
    const {gl} = this.context;
    const {attributeManager} = this.state;
    const noAlloc = true;

    /* eslint-disable max-len */
    attributeManager.add({
      indices: {size: 1, isIndexed: true, update: this.calculateIndices, noAlloc},
      positions: {size: 4, accessor: 'getPosition', update: this.calculatePositions, noAlloc},
      colors: {size: 4, accessor: ['getPosition', 'getColor'],
        type: GL.UNSIGNED_BYTE, update: this.calculateColors, noAlloc},
      pickingColors: {size: 3, type: GL.UNSIGNED_BYTE, update: this.calculatePickingColors, noAlloc}
    });
    /* eslint-enable max-len */

    gl.getExtension('OES_element_index_uint');
    this.setState({
      model: this.getModel(gl)
    });
  }

  updateState({oldProps, props, changeFlags}) {
    if (changeFlags.propsChanged) {
      const {uCount, vCount} = props;

      if (oldProps.uCount !== uCount ||
        oldProps.vCount !== vCount) {
        this.setState({
          vertexCount: uCount * vCount
        });
        this.state.attributeManager.invalidateAll();
      }

    }
  }

  getModel(gl) {
    // 3d surface
    const graphShaders = assembleShaders(gl, {
      vs: surfaceVertex,
      fs: fragmentShader
    });

    return new Model({
      gl,
      id: `${this.props.id}-surface`,
      vs: graphShaders.vs,
      fs: graphShaders.fs,
      geometry: new Geometry({
        drawMode: GL.TRIANGLES
      }),
      vertexCount: 0,
      isIndexed: true
    });

  }

  draw({uniforms}) {
    const {lightStrength} = this.props;

    this.state.model.render(Object.assign({}, uniforms, {
      lightStrength
    }));
  }

  /*
   * y 1
   *   ^
   *   |
   *   |
   *   |
   *   0--------> 1
   *              x
   */
  encodePickingColor(i) {
    const {uCount, vCount} = this.props;

    const xIndex = i % uCount;
    const yIndex = (i - xIndex) / uCount;

    return [
      xIndex / (uCount - 1) * 255,
      yIndex / (vCount - 1) * 255,
      1
    ];
  }

  decodePickingColor([r, g, b]) {
    if (b === 0) {
      return -1;
    }
    return [r / 255, g / 255];
  }

  getPickingInfo(opts) {
    const {info} = opts;

    if (info && info.index !== -1) {
      const [u, v] = info.index;
      const {getPosition} = this.props;

      info.sample = getPosition(u, v);
    }

    return info;
  }

  calculateIndices(attribute) {
    const {uCount, vCount} = this.props;
    // # of squares = (nx - 1) * (ny - 1)
    // # of triangles = squares * 2
    // # of indices = triangles * 3
    const indicesCount = (uCount - 1) * (vCount - 1) * 2 * 3;
    const indices = new Uint32Array(indicesCount);

    let i = 0;
    for (let xIndex = 0; xIndex < uCount - 1; xIndex++) {
      for (let yIndex = 0; yIndex < vCount - 1; yIndex++) {
        /*
         *   i0   i1
         *    +--.+---
         *    | / |
         *    +'--+---
         *    |   |
         *   i2   i3
         */
        const i0 = yIndex * uCount + xIndex;
        const i1 = i0 + 1;
        const i2 = i0 + uCount;
        const i3 = i2 + 1;

        indices[i++] = i0;
        indices[i++] = i2;
        indices[i++] = i1;
        indices[i++] = i1;
        indices[i++] = i2;
        indices[i++] = i3;
      }
    }

    attribute.value = indices;
    this.state.model.setVertexCount(indicesCount);
  }

  // the fourth component is a flag for invalid z (NaN or Infinity)
  /* eslint-disable max-statements */
  calculatePositions(attribute) {
    const {vertexCount} = this.state;
    const {uCount, vCount, getPosition, getXScale, getYScale, getZScale} = this.props;

    // calculate z range
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;

    const value = new Float32Array(vertexCount * attribute.size);

    let i = 0;
    for (let vIndex = 0; vIndex < vCount; vIndex++) {
      for (let uIndex = 0; uIndex < uCount; uIndex++) {
        const u = uIndex / (uCount - 1);
        const v = vIndex / (vCount - 1);
        let [x, y, z] = getPosition(u, v);

        const isXFinite = isFinite(x);
        const isYFinite = isFinite(y);
        const isZFinite = isFinite(z);
        if (!isXFinite) {
          x = 0;
        }
        if (!isYFinite) {
          y = 0;
        }
        if (!isZFinite) {
          z = 0;
        }

        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);

        // swap z and y: y is up in the default viewport
        value[i++] = x;
        value[i++] = z;
        value[i++] = y;
        value[i++] = isXFinite && isYFinite && isZFinite ? 0 : 1;
      }
    }

    const xScale = getXScale({min: xMin, max: xMax});
    const yScale = getYScale({min: yMin, max: yMax});
    const zScale = getZScale({min: zMin, max: zMax});

    for (let j = 0; j < vertexCount; j++) {
      const startIndex = j * 4;
      if (!value[startIndex + 3]) {
        value[startIndex] = xScale(value[startIndex]);
        value[startIndex + 1] = zScale(value[startIndex + 1]);
        value[startIndex + 2] = yScale(value[startIndex + 2]);
      }
    }

    attribute.value = value;
    this.props.onUpdate({xScale, yScale, zScale});
  }
  /* eslint-enable max-statements */

  calculateColors(attribute) {
    const {vertexCount, attributeManager} = this.state;
    const {getColor} = this.props;

    // reuse the calculated [x, y, z] in positions
    const positions = attributeManager.attributes.positions.value;
    const value = new Uint8ClampedArray(vertexCount * attribute.size);

    for (let i = 0; i < vertexCount; i++) {
      const index = i * 4;
      const color = getColor(positions[index], positions[index + 2], positions[index + 1]);
      value[i * 4] = color[0];
      value[i * 4 + 1] = color[1];
      value[i * 4 + 2] = color[2];
      value[i * 4 + 3] = isNaN(color[3]) ? 255 : color[3];
    }

    attribute.value = value;
  }

  calculatePickingColors(attribute) {
    const {vertexCount} = this.state;

    const value = new Uint8ClampedArray(vertexCount * attribute.size);

    for (let i = 0; i < vertexCount; i++) {
      const pickingColor = this.encodePickingColor(i);
      value[i * 3] = pickingColor[0];
      value[i * 3 + 1] = pickingColor[1];
      value[i * 3 + 2] = pickingColor[2];
    }

    attribute.value = value;
  }

}

SurfaceLayer.layerName = 'SurfaceLayer';
SurfaceLayer.defaultProps = defaultProps;

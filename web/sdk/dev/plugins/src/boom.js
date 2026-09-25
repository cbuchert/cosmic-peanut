// @ts-check
/** @type {import('../../../tidalviz').CreateVisualizer} */
export default function create() {
  return {
    frame() {
      throw new Error("boom from frame");
    },
  };
}

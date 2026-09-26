// @ts-check
/**
 * Transparent-canvas helper. The SDK's canvas is premultiplied and the shell supplies the backdrop
 * (black, or the desktop). A glow rendered "on black" is already premultiplied colour; giving it
 * alpha = its brightest channel keeps it identical over black and makes it float over the desktop.
 */

/**
 * Append `gl_FragColor.a = max(r, g, b)` as the last statement of a GLSL fragment shader's main()
 * (the source must end with main's closing brace, like three's OutputShader).
 * @param {string} src
 */
export function alphaFromBrightness(src) {
  const end = src.lastIndexOf("}");
  if (end < 0 || src.slice(end + 1).trim()) throw new Error("fragment shader must end with main's closing brace");
  return (
    src.slice(0, end) +
    "  gl_FragColor.a = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));\n" +
    src.slice(end)
  );
}

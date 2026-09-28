#version 300 es
// Vertex pulling: instance = particle, 4 strip vertices = a thin quad stretched along velocity
// from the particle (head) back to where it was u_streak seconds ago (tail). No CPU readback.
precision highp float;
precision highp int;
uniform highp sampler2D u_s0;
uniform highp sampler2D u_s1;
uniform int u_count;
uniform float u_aspect;     // width / height
uniform vec2 u_px;          // one pixel in height units (x, y)
uniform float u_streak;     // seconds of motion a streak spans
uniform float u_width;      // base half-width in pixels
out vec2 v_q;               // x: across (-1..1), y: along (0 tail .. 1 head)
out float v_bright;
out float v_t;              // palette position
void main() {
  int id = gl_InstanceID;
  int w = textureSize(u_s0, 0).x;
  ivec2 ij = ivec2(id % w, id / w);
  vec4 s0 = texelFetch(u_s0, ij, 0);
  vec4 s1 = texelFetch(u_s1, ij, 0);
  float kind = s1.y;
  if (kind < 0.5 || id >= u_count) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 p = s0.xy;
  vec2 v = s0.zw;
  float speed = length(v);
  bool spray = kind > 1.5;
  vec2 dir = speed > 1e-5 ? v / speed : vec2(0.0, -1.0);
  // Length: motion over u_streak, at least a couple of pixels; faster = longer.
  float len = max(speed * u_streak * (spray ? 0.6 : 1.0), 2.5 * u_px.y);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfW = u_width * (spray ? 0.8 : (0.7 + 0.6 * s1.z));
  int c = gl_VertexID;
  float along = float(c >> 1);          // 0 tail, 1 head
  float across = float(c & 1) * 2.0 - 1.0;
  vec2 pos = p - dir * len * (1.0 - along) + nrm * across * halfW * u_px.y * 1.5;
  gl_Position = vec4(pos.x * 2.0 / u_aspect, pos.y * 2.0 - 1.0, 0.0, 1.0);
  v_q = vec2(across * 1.5, along);
  float life = spray ? clamp(1.0 - s1.x / max(s1.w, 1e-3), 0.0, 1.0) : 1.0;
  float fresh = spray ? 0.0 : clamp(s1.x * 25.0, 0.0, 1.0); // fade in over the lip
  // Fresh water on the lip is a glassy highlight; then colour and brightness follow speed.
  float lip = spray ? 0.0 : 1.0 - clamp(s1.x * 4.0, 0.0, 1.0);
  v_t = spray ? 0.45 + 0.5 * life : clamp(0.15 + speed * 0.5 + 0.25 * s1.z + 0.35 * lip, 0.0, 1.0);
  v_bright = spray ? 0.9 * life * (0.4 + s1.z)
                   : fresh * (0.3 + 0.7 * s1.z) * (0.45 + speed * 0.6 + 0.8 * lip);
}

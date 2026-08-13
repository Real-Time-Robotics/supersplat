// Splat value encodings, kept free of playcanvas imports so non-render code
// (readers, node tests) can use them.

const SH_C0 = 0.28209479177387814;

const dcDecode = (v: number) => v * SH_C0 + 0.5;
const dcEncode = (v: number) => (v - 0.5) / SH_C0;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v: number) => ((v <= 0) ? -400 : ((v >= 1) ? 400 : -Math.log(1 / v - 1)));

export { dcDecode, dcEncode, invSigmoid, sigmoid, SH_C0 };

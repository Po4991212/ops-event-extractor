'use strict';
const parsers = [
  require('./twia'), require('./ringcentral'), require('./foxquilt'), require('./hellosign'),
  require('./ipfs'), require('./progressive'), require('./coisolution'), require('./amwins_tfia'),
  require('./wholesure'),
];
const byFamily = new Map(parsers.map((p) => [p.family, p]));
module.exports = { parsers, byFamily, FAMILIES: parsers.map((p) => p.family) };

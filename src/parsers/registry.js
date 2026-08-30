import ringcentral from './ringcentral.js';
import foxquilt from './foxquilt.js';
import twia from './twia.js';
import hellosign from './hellosign.js';
import ipfs from './ipfs.js';
import progressive from './progressive.js';
import coisolution from './coisolution.js';

// Order matters for the routing histogram in §4.1 but not for correctness:
// each parser's match() is scoped to its own sender domain, so at most one
// can ever claim a given message. RingCentral and Foxquilt are listed first
// per §4.3 ("Foxquilt second... because that's where the actual lapse
// happened and you want that replay working early").
export const parsers = [ringcentral, foxquilt, twia, hellosign, ipfs, progressive, coisolution];

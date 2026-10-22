// Worker entry for snarkjs's proving threads (see worker-shim.js). build.js
// resolves this import to ffjavascript's own thread source, the code its
// blob: URL would have run.
import thread from 'ffjavascript-thread';

thread(self);

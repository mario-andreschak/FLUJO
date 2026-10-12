'use strict';

/** Every owned cleanup runs; earlier failures remain attached to the result. */
async function closeAndRestoreFixture(transport, restoreEnvironment, restoreFixture, primaryError) {
 const failures=[];
 try{if(transport)await transport.close();}catch(error){failures.push(error);}
 try{restoreEnvironment();}catch(error){failures.push(error);}
 try{await restoreFixture();}catch(error){failures.push(error);}
 if(failures.length){
  if(primaryError!==undefined)failures.unshift(primaryError);
  if(failures.length===1)throw failures[0];
  throw new AggregateError(failures,'Owned Source fixture cleanup failed.',{cause:failures[0]});
 }
}
module.exports={closeAndRestoreFixture};

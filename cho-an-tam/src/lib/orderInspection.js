// Compatibility export; the one lifecycle worker owns all deadlines.
const {runOrderLifecycle,startOrderLifecycleWorker}=require('./orderLifecycle');
module.exports={expireInspections:runOrderLifecycle,startInspectionWorker:startOrderLifecycleWorker};

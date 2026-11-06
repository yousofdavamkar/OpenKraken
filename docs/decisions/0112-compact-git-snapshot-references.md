# 0112. Compact ordinary references between the Git utility and main

Electron copies each reference across a process boundary when opening or refreshing a repository. For an ordinary branch, remote-tracking branch or lightweight tag, the target and full name determine every other field in the record. At 50,000 refs, the ordinary copy from the utility to main took 116–123 ms in three instrumented runs.

For snapshots containing at least 10,000 refs, the utility encodes these records as `target:fullName` when at least half qualify. The first colon follows the object ID. The namespace supplies the kind and short name. Only commit targets with canonical names, an explicit false HEAD flag, empty peeled type and absent peeled object and upstream qualify. Other refs travel as full records in their original positions. These size and density thresholds limit the optimization to large replies dominated by simple records.

Main validates the response envelope and snapshot, expands packed rows in one pass, checks each object ID with the shared SHA-1/SHA-256 rule and parses each full record with the ordinary ref schema. A malformed row rejects the response. Both public renderer response formats receive the complete ordered reference list. Any future change to the reference schema must preserve this round trip for every compactable record.

The instrumented compact transfer took 47–50 ms plus 9–12 ms for packing. Extending the format to the renderer reduced JSON bytes but added serialization work in main, and three uninstrumented trials showed no first-paint gain over compacting only the utility reply. Measurements and rejected alternatives are in the [reference performance record](../verification/m8-reference-performance.md#git-utility-snapshot-transfer).

"""Execute unmodified extractor initialization, then exercise inherited limits."""
import json
import resource
import runpy
import sys

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
runpy.run_path(sys.argv[1], run_name="document_limit_probe")
print(json.dumps({"cpu": resource.getrlimit(resource.RLIMIT_CPU),
                  "address_space": resource.getrlimit(resource.RLIMIT_AS)}), flush=True)
match sys.argv[2]:  # noqa: MATCH_OK — external open-string input; unknown modes exit 64.
    case "cpu":
        while True:
            sum(range(10000))
    case "address-space":
        try:
            allocation = bytearray(256 * 1024 * 1024)
        except MemoryError:
            print("address_space_allocation_rejected", flush=True)
        else:
            sys.exit(65)
    case _:
        sys.exit(64)

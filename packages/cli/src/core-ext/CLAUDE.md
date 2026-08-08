# product/packages/cli/src/core-ext/

run の配線層(昇格対象外)。fs / killswitch / scaffold / doctor / triggers は
@tsurupong/halo-core へ昇格済みで、後方互換 re-export shim も撤去済み(issue #56)。
残るのは run-wiring 系のみ — CLI 型(RunHooks/RunContext)への逆依存と node 直依存を
持つため core には昇格せず、CLI 固有の配線としてここに置く。

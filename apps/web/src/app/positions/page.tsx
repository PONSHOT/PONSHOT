"use client";

import {MyPredictions} from "@/components/MyPredictions";

export default function PositionsPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-bold text-white">Positions</h1>
      <p className="mb-4 text-xs text-mute-500">
        Every round you have entered, read live from the contract. Claims are permissionless — nobody has to
        approve them, and they stay available whether or not the market is paused.
      </p>
      <MyPredictions />
    </>
  );
}

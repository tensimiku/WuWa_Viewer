using System.Numerics;
using CUE4Parse.UE4.Objects.Core.Math;

namespace WuWaViewer.Server.Services;

/// <summary>
/// Converts Unreal Engine Z-up left-handed coordinates (cm) to Three.js / glTF Y-up right-handed (m)
/// matching CUE4Parse-Conversion's Writers/Gltf/Gltf.cs convention.
/// </summary>
public static class CoordConvert
{
    public const float UnitScale = 0.01f;

    public static float[] SwapPos(FVector v, bool applyScale = true)
    {
        var s = applyScale ? UnitScale : 1f;
        return [v.X * s, v.Z * s, v.Y * s];
    }

    public static float[] SwapVector(FVector v)
        => [v.X, v.Z, v.Y];

    public static float[] SwapQuat(FQuat q)
        => [q.X, q.Z, q.Y, -q.W];

    public static float[] SwapScale(FVector v)
        => [v.X, v.Z, v.Y];

    public static float[] SwapRotatorToQuat(FRotator r)
        => SwapQuat(r.Quaternion());

    public static (float[] Pos, float[] Quat, float[] Scale) SwapTransform(FTransform t)
        => (SwapPos(t.Translation), SwapQuat(t.Rotation), SwapScale(t.Scale3D));

    public static FVector NormalizeSafe(FVector v)
    {
        var len = MathF.Sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z);
        return len > 1e-6f ? new FVector(v.X / len, v.Y / len, v.Z / len) : new FVector(0, 0, 1);
    }

    public static float[] EulerDegUeToQuatYUp(float rollDeg, float pitchDeg, float yawDeg)
    {
        var r = new FRotator(pitchDeg, yawDeg, rollDeg);
        var q = r.Quaternion();
        return [q.X, q.Z, q.Y, -q.W];
    }

    public static float[] MultiplyQuat(float[] a, float[] b)
    {
        var qa = new Quaternion(a[0], a[1], a[2], a[3]);
        var qb = new Quaternion(b[0], b[1], b[2], b[3]);
        var r = Quaternion.Normalize(qa * qb);
        return [r.X, r.Y, r.Z, r.W];
    }
}

